import { purgeExpiredReceipts, storeReceipt } from "@/lib/receipts/store";
import { inspectReceiptUpload } from "@/lib/receipts/inspect";
import { receiptRetentionDays, RECEIPT_BUCKET } from "@/lib/receipts/policy";

test("stores unchanged original bytes with checksum, uploader and the existing retention deadline", async () => {
  const bytes = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  const inspected = inspectReceiptUpload({ bytes, declaredType: "image/jpeg", fileName: "original.jpg", caption: "", maxBytes: 1024 });
  const now = new Date("2026-10-20T12:00:00Z");
  let saved: Record<string, unknown> = {};
  const insert: { insert: jest.Mock; select: jest.Mock; single: jest.Mock } = { insert: jest.fn((row) => { saved = row; return insert; }), select: jest.fn(() => insert),
    single: jest.fn(async () => ({ data: saved, error: null })) };
  const count: { select: jest.Mock; eq: jest.Mock; neq: jest.Mock } = { select: jest.fn(() => count), eq: jest.fn(() => count), neq: jest.fn(async () => ({ count: 0, error: null })) };
  const upload = jest.fn(async () => ({ error: null }));
  const storage = { upload, remove: jest.fn() };
  const client = { from: jest.fn().mockReturnValueOnce(count).mockReturnValueOnce(insert), storage: { from: jest.fn(() => storage) } };
  await storeReceipt(client as never, { expenseId: "expense", wallet: "UPLOADER", inspected, bytes, now });
  expect(client.storage.from).toHaveBeenCalledWith(RECEIPT_BUCKET);
  expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^receipts\/expense\//), bytes, expect.objectContaining({ upsert: false, cacheControl: "private, max-age=0, no-store" }));
  expect(saved).toEqual(expect.objectContaining({ uploaded_by_wallet: "UPLOADER", checksum_sha256: inspected.checksum,
    retain_until: new Date(now.getTime() + receiptRetentionDays() * 86400000).toISOString() }));
});

test("purges expired and orphaned originals, drops private display data, and retains failed deletions for retry", async () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const due = [
    { id: "expired", storage_path: "receipts/expired.jpg", expense_id: "expense" },
    { id: "orphan", storage_path: "receipts/orphan.jpg", expense_id: null },
    { id: "retry", storage_path: "receipts/retry.jpg", expense_id: "expense" },
  ];
  const query: { select: jest.Mock; neq: jest.Mock; or: jest.Mock; limit: jest.Mock } = { select: jest.fn(() => query), neq: jest.fn(() => query), or: jest.fn(() => query), limit: jest.fn(async () => ({ data: due, error: null })) };
  const updates: Array<{ patch: Record<string, unknown>; id: string }> = [];
  const remove = jest.fn(async ([path]: string[]) => ({ error: path.endsWith("retry.jpg") ? new Error("storage unavailable") : null }));
  const client = { storage: { from: () => ({ remove }) }, from: jest.fn().mockReturnValueOnce(query).mockImplementation(() => ({
    update: (patch: Record<string, unknown>) => ({ eq: async (_key: string, id: string) => { updates.push({ patch, id }); return { error: null }; } }),
  })) };
  expect(await purgeExpiredReceipts(client as never, { now })).toEqual({ purged: 2, failed: 1 });
  expect(query.or).toHaveBeenCalledWith(`retain_until.lte.${now.toISOString()},expense_id.is.null`);
  expect(updates.map((update) => update.id)).toEqual(["expired", "orphan"]);
  expect(updates[0].patch).toEqual(expect.objectContaining({ status: "removed", file_name: null, caption: null, removal_reason: "retention" }));
  expect(updates[1].patch.removal_reason).toBe("expense_deleted");
  expect(remove).toHaveBeenCalledTimes(3);
});
