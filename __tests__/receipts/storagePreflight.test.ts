import { File } from "node:buffer";
import { checkReceiptStorage } from "@/lib/receipts/client";
jest.mock("@/lib/supabase/session", () => ({ getAccessToken: () => "wallet-session" }));
const file = new File(["original"], "r.jpg") as unknown as globalThis.File;
test("requires an authenticated private storage check before submitting a receipt-assisted expense", async () => {
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { maxBytes: 1024 } }) });
  await expect(checkReceiptStorage(file, fetcher)).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledWith("/api/receipts/capabilities", expect.objectContaining({ headers: { Authorization: "Bearer wallet-session" } }));
});
test.each([1, 0, Number.NaN])("rejects originals that cannot fit configured limit %s", async (maxBytes) => {
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { maxBytes } }) });
  await expect(checkReceiptStorage(file, fetcher)).rejects.toThrow("storage limit");
});
test("preserves the server's actionable storage-not-ready error", async () => {
  const fetcher = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "Private receipt storage is not ready." }) });
  await expect(checkReceiptStorage(file, fetcher)).rejects.toThrow("not ready");
});
