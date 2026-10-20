import { createReceiptLink, storeReceipt } from "@/lib/receipts/store";
import { inspectReceiptUpload } from "@/lib/receipts/inspect";
import { RECEIPT_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/receipts/policy";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function fakeClient({ insertError = null as null | { code: string } } = {}) {
  const bucket = {
    upload: jest.fn().mockResolvedValue({ error: null }),
    remove: jest.fn().mockResolvedValue({ error: null }),
    createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: "https://signed" }, error: null }),
  };
  const countQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockResolvedValue({ count: 0, error: null }),
  };
  const insertQuery = {
    insert: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: insertError }),
  };
  let call = 0;
  const client = {
    storage: { from: jest.fn(() => bucket) },
    from: jest.fn(() => (call++ === 0 ? countQuery : insertQuery)),
  };
  return { client: client as never, bucket };
}

describe("createReceiptLink", () => {
  it("signs for exactly the TTL and reports when the link expires", async () => {
    const { client, bucket } = fakeClient();
    const now = new Date("2026-10-01T00:00:00.000Z");
    const link = await createReceiptLink(client, "receipts/e/r.pdf", "bill.pdf", now);

    expect(bucket.createSignedUrl).toHaveBeenCalledWith("receipts/e/r.pdf", SIGNED_URL_TTL_SECONDS, { download: "bill.pdf" });
    expect(link.expiresAt).toBe(new Date(now.getTime() + SIGNED_URL_TTL_SECONDS * 1000).toISOString());
  });

  it("refuses to sign anything under the quarantine prefix", async () => {
    const { client, bucket } = fakeClient();
    await expect(createReceiptLink(client, "quarantine/e/r.pdf", null)).rejects.toMatchObject({ status: 403 });
    expect(bucket.createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("storeReceipt", () => {
  const inspected = inspectReceiptUpload({
    bytes: JPEG,
    declaredType: "image/jpeg",
    fileName: "bill.jpg",
    caption: null,
    maxBytes: 1024,
  });

  it("uploads to the private bucket and removes the object when metadata fails (duplicate)", async () => {
    const { client, bucket } = fakeClient({ insertError: { code: "23505" } });
    await expect(
      storeReceipt(client, { expenseId: "e1", wallet: "GPAYER", inspected, bytes: JPEG }),
    ).rejects.toMatchObject({ status: 409 });

    const [path, , options] = bucket.upload.mock.calls[0];
    expect(path).toMatch(/^receipts\/e1\/[0-9a-f-]{36}\.jpg$/);
    expect(options).toMatchObject({ contentType: "image/jpeg", upsert: false });
    expect(bucket.remove).toHaveBeenCalledWith([path]);
    expect((client as unknown as { storage: { from: jest.Mock } }).storage.from).toHaveBeenCalledWith(RECEIPT_BUCKET);
  });
});
