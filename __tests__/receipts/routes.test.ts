import { NextRequest } from "next/server";
import { GET as listRoute, POST as uploadRoute } from "@/app/api/expenses/[id]/receipts/route";
import { DELETE as removeRoute, GET as linkRoute } from "@/app/api/receipts/[receiptId]/route";
import { GET as retentionRoute } from "@/app/api/receipts/retention/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import * as store from "@/lib/receipts/store";
import type { ExpenseReceipt } from "@/types/receipt";

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => true,
  createServerClientForToken: () => ({ kind: "user" }),
  createServiceRoleClient: () => ({ kind: "service" }),
}));

jest.mock("@/lib/receipts/store", () => {
  const actual = jest.requireActual("@/lib/receipts/store");
  return {
    ...actual,
    loadExpenseAccess: jest.fn(),
    listReceipts: jest.fn(),
    loadReceipt: jest.fn(),
    storeReceipt: jest.fn(),
    createReceiptLink: jest.fn(),
    removeReceipt: jest.fn(),
    purgeExpiredReceipts: jest.fn(),
  };
});

const mocked = store as jest.Mocked<typeof store>;

const PAYER = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const MEMBER = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const EXPENSE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const receipt = (overrides: Partial<ExpenseReceipt> = {}): ExpenseReceipt => ({
  id: RECEIPT_ID,
  expenseId: EXPENSE_ID,
  fileName: "bill.jpg",
  contentType: "image/jpeg",
  sizeBytes: JPEG.length,
  checksum: "a".repeat(64),
  caption: null,
  status: "active",
  uploadedByWallet: PAYER,
  createdAt: "2026-10-01T00:00:00.000Z",
  retainUntil: "2028-10-01T00:00:00.000Z",
  removedAt: null,
  ...overrides,
});

function request(url: string, { wallet = PAYER, method = "GET", body }: { wallet?: string | null; method?: string; body?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (wallet) headers.Authorization = `Bearer ${signWalletSession(wallet)}`;
  return new NextRequest(url, { method, headers, body });
}

const expenseCtx = { params: Promise.resolve({ id: EXPENSE_ID }) };
const receiptCtx = { params: Promise.resolve({ receiptId: RECEIPT_ID }) };

function uploadForm(file: Blob, name: string, caption?: string) {
  const form = new FormData();
  form.append("file", file, name);
  if (caption) form.append("caption", caption);
  return form;
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.loadExpenseAccess.mockResolvedValue({ expenseId: EXPENSE_ID, createdByWallet: PAYER, payerWallet: PAYER });
  mocked.storeReceipt.mockImplementation(async (_client, { inspected }) =>
    receipt({ contentType: inspected.contentType, caption: inspected.caption }),
  );
});

describe("access denial", () => {
  it("requires a wallet session", async () => {
    const res = await listRoute(request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, { wallet: null }), expenseCtx);
    expect(res.status).toBe(401);
  });

  it("reports an expense the caller cannot see as not found (no id probing)", async () => {
    mocked.loadExpenseAccess.mockResolvedValue(null);
    const res = await listRoute(request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, { wallet: MEMBER }), expenseCtx);
    expect(res.status).toBe(404);
    expect(mocked.listReceipts).not.toHaveBeenCalled();
  });

  it("refuses uploads from members who did not pay", async () => {
    const res = await uploadRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, {
        wallet: MEMBER,
        method: "POST",
        body: uploadForm(new Blob([JPEG], { type: "image/jpeg" }), "bill.jpg"),
      }),
      expenseCtx,
    );
    expect(res.status).toBe(403);
    expect(mocked.storeReceipt).not.toHaveBeenCalled();
  });

  it("does not sign a link for a receipt the caller cannot see", async () => {
    mocked.loadReceipt.mockResolvedValue(null);
    const res = await linkRoute(request(`http://x/api/receipts/${RECEIPT_ID}`, { wallet: MEMBER }), receiptCtx);
    expect(res.status).toBe(404);
    expect(mocked.createReceiptLink).not.toHaveBeenCalled();
  });

  it("never signs a quarantined receipt", async () => {
    mocked.loadReceipt.mockResolvedValue({
      receipt: receipt({ status: "quarantined" }),
      storagePath: `quarantine/${EXPENSE_ID}/${RECEIPT_ID}.jpg`,
    });
    const res = await linkRoute(request(`http://x/api/receipts/${RECEIPT_ID}`), receiptCtx);
    expect(res.status).toBe(403);
    expect(mocked.createReceiptLink).not.toHaveBeenCalled();
  });

  it("refuses removal by someone who neither uploaded nor created", async () => {
    mocked.loadReceipt.mockResolvedValue({ receipt: receipt(), storagePath: "receipts/e/r.jpg" });
    const res = await removeRoute(request(`http://x/api/receipts/${RECEIPT_ID}`, { wallet: MEMBER, method: "DELETE" }), receiptCtx);
    expect(res.status).toBe(403);
    expect(mocked.removeReceipt).not.toHaveBeenCalled();
  });

  it("rejects malformed ids before touching the database", async () => {
    const res = await linkRoute(request("http://x/api/receipts/x"), { params: Promise.resolve({ receiptId: "../etc" }) });
    expect(res.status).toBe(404);
    expect(mocked.loadReceipt).not.toHaveBeenCalled();
  });
});

describe("mobile upload", () => {
  it("accepts a camera capture with a generic name and no declared type", async () => {
    const res = await uploadRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, {
        method: "POST",
        body: uploadForm(new Blob([JPEG]), "image.jpg", "Taxi from airport"),
      }),
      expenseCtx,
    );
    expect(res.status).toBe(201);
    const [, args] = mocked.storeReceipt.mock.calls[0];
    expect(args.inspected.contentType).toBe("image/jpeg");
    expect(args.inspected.caption).toBe("Taxi from airport");
    expect(args.wallet).toBe(PAYER);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("rejects a disguised file", async () => {
    const res = await uploadRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, {
        method: "POST",
        body: uploadForm(new Blob(["<html><script>x</script></html>"], { type: "image/jpeg" }), "bill.jpg"),
      }),
      expenseCtx,
    );
    expect(res.status).toBe(415);
    expect(mocked.storeReceipt).not.toHaveBeenCalled();
  });

  it("rejects a request without a file", async () => {
    const form = new FormData();
    form.append("caption", "no file");
    const res = await uploadRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, { method: "POST", body: form }),
      expenseCtx,
    );
    expect(res.status).toBe(400);
  });
});

describe("links and removal", () => {
  it("returns a short-lived link for an active receipt", async () => {
    mocked.loadReceipt.mockResolvedValue({ receipt: receipt(), storagePath: "receipts/e/r.jpg" });
    mocked.createReceiptLink.mockResolvedValue({ url: "https://storage/signed", expiresAt: "2026-10-01T00:01:00.000Z" });
    const res = await linkRoute(request(`http://x/api/receipts/${RECEIPT_ID}`, { wallet: MEMBER }), receiptCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.url).toBe("https://storage/signed");
  });

  it("reports a removed receipt as gone", async () => {
    mocked.loadReceipt.mockResolvedValue({ receipt: receipt({ status: "removed" }), storagePath: "receipts/e/r.jpg" });
    const res = await linkRoute(request(`http://x/api/receipts/${RECEIPT_ID}`), receiptCtx);
    expect(res.status).toBe(410);
  });

  it("lets the uploader remove their receipt", async () => {
    mocked.loadReceipt.mockResolvedValue({ receipt: receipt(), storagePath: "receipts/e/r.jpg" });
    const res = await removeRoute(request(`http://x/api/receipts/${RECEIPT_ID}`, { method: "DELETE" }), receiptCtx);
    expect(res.status).toBe(200);
    expect(mocked.removeReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ receiptId: RECEIPT_ID, wallet: PAYER, reason: "user" }),
    );
  });
});

describe("retention sweep", () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    process.env.CRON_SECRET = original;
  });

  it("is disabled without CRON_SECRET and rejects wrong secrets", async () => {
    delete process.env.CRON_SECRET;
    expect((await retentionRoute(new NextRequest("http://x/api/receipts/retention"))).status).toBe(401);

    process.env.CRON_SECRET = "s3cret";
    const wrong = new NextRequest("http://x/api/receipts/retention", { headers: { Authorization: "Bearer nope" } });
    expect((await retentionRoute(wrong)).status).toBe(401);
    expect(mocked.purgeExpiredReceipts).not.toHaveBeenCalled();
  });

  it("purges with the right secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    mocked.purgeExpiredReceipts.mockResolvedValue({ purged: 2, failed: 0 });
    const res = await retentionRoute(
      new NextRequest("http://x/api/receipts/retention", { headers: { Authorization: "Bearer s3cret" } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ purged: 2, failed: 0 });
  });
});
