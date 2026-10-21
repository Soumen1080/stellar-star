import { NextRequest } from "next/server";
import { GET } from "@/app/api/receipts/capabilities/route";
import { receiptClients, receiptError } from "@/lib/receipts/http";
jest.mock("@/lib/receipts/http", () => ({ ...jest.requireActual("@/lib/receipts/http"), receiptClients: jest.fn() }));
const clients = jest.mocked(receiptClients);
const bucket = jest.fn();
const schema = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  bucket.mockResolvedValue({ data: { public: false, file_size_limit: 4194304 }, error: null });
  schema.mockResolvedValue({ error: null, data: [] });
  clients.mockReturnValue({ serviceClient: { storage: { getBucket: bucket }, from: () => ({ select: () => ({ limit: schema }) }) } } as unknown as ReturnType<typeof receiptClients>);
});
test("requires authentication before checking private storage", async () => {
  clients.mockReturnValue({ response: receiptError("Unauthorized", 401) });
  expect((await GET(new NextRequest("http://x/api/receipts/capabilities"))).status).toBe(401);
  expect(bucket).not.toHaveBeenCalled();
});
test("reports the effective upload limit without returning any receipt data", async () => {
  bucket.mockResolvedValue({ data: { public: false, file_size_limit: 1024 }, error: null });
  const response = await GET(new NextRequest("http://x/api/receipts/capabilities"));
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(await response.json()).toEqual({ data: { maxBytes: 1024 } });
});
test.each(["public bucket", "missing schema", "missing bucket"])("blocks creation with %s", async (problem) => {
  if (problem === "public bucket") bucket.mockResolvedValue({ data: { public: true }, error: null });
  if (problem === "missing schema") schema.mockResolvedValue({ error: new Error("sensitive database error") });
  if (problem === "missing bucket") bucket.mockResolvedValue({ data: null, error: new Error("missing") });
  const response = await GET(new NextRequest("http://x/api/receipts/capabilities"));
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("has not been created");
});
