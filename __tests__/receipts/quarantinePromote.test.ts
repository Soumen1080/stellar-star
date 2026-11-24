import { NextRequest } from "next/server";
import { POST as intentRoute } from "@/app/api/expenses/[id]/receipts/intent/route";
import { POST as uploadRoute } from "@/app/api/expenses/[id]/receipts/route";
import { GET as linkRoute } from "@/app/api/receipts/[receiptId]/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import * as store from "@/lib/receipts/store";
import * as intentModule from "@/lib/receipts/intent";
import type { ExpenseReceipt } from "@/types/receipt";

jest.mock("@/lib/supabase/queries", () => ({
  hasExpensePermission: jest.fn(
    async (_id, _permission, client) =>
      client.wallet === "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV",
  ),
}));

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => true,
  createServerClientForToken: (token: string) => ({
    kind: "user",
    wallet: jest.requireActual("@/lib/supabase/serverAuth").verifyWalletSession(token)?.wallet_address,
  }),
  createServiceRoleClient: () => ({
    kind: "service",
    rpc: jest.fn().mockResolvedValue({
      data: { allowed: true, remaining: 10, reset_ms: 60000 },
      error: null,
    }),
  }),
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

jest.mock("@/lib/receipts/intent", () => {
  const actual = jest.requireActual("@/lib/receipts/intent");
  return {
    ...actual,
    createUploadIntent: jest.fn(),
    loadUploadIntent: jest.fn(),
    cleanupAbandonedUploads: jest.fn(),
  };
});

const mockedStore = store as jest.Mocked<typeof store>;
const mockedIntent = intentModule as jest.Mocked<typeof intentModule>;

const PAYER = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ATTACKER = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const EXPENSE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function request(
  url: string,
  {
    wallet = PAYER,
    method = "POST",
    body,
    headers: extraHeaders = {},
    idempotencyKey = crypto.randomUUID(),
  }: {
    wallet?: string | null;
    method?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
    idempotencyKey?: string | null;
  } = {},
) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (wallet) headers.Authorization = `Bearer ${signWalletSession(wallet)}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return new NextRequest(url, { method, headers, body });
}

const expenseCtx = { params: Promise.resolve({ id: EXPENSE_ID }) };
const receiptCtx = { params: Promise.resolve({ receiptId: RECEIPT_ID }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockedStore.loadExpenseAccess.mockResolvedValue({
    expenseId: EXPENSE_ID,
    createdByWallet: PAYER,
    payerWallet: PAYER,
  });
});

describe("short-lived upload intents route (#451)", () => {
  it("creates an upload intent for an authorized member", async () => {
    mockedIntent.createUploadIntent.mockResolvedValue({
      id: "intent-123",
      expenseId: EXPENSE_ID,
      wallet: PAYER,
      idempotencyKey: "idem-key",
      status: "pending",
      fileName: null,
      contentType: null,
      sizeBytes: null,
      checksum: null,
      caption: null,
      storagePath: null,
      promotedPath: null,
      scanResult: {},
      receiptId: null,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await intentRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts/intent`, {
        idempotencyKey: "idem-key",
      }),
      expenseCtx,
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.id).toBe("intent-123");
    expect(json.data.maxBytes).toBeGreaterThan(0);
    expect(json.data.allowedTypes).toContain("image/jpeg");
  });

  it("refuses upload intent creation from unauthorized users", async () => {
    const res = await intentRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts/intent`, {
        wallet: ATTACKER,
      }),
      expenseCtx,
    );
    expect(res.status).toBe(403);
    expect(mockedIntent.createUploadIntent).not.toHaveBeenCalled();
  });
});

describe("spoofed, oversized, and infected file prevention (#451)", () => {
  it("rejects spoofed file where magic bytes contradict client Content-Type", async () => {
    const form = new FormData();
    // Spoofed: Client declares image/png, but sends HTML/script
    form.append(
      "file",
      new Blob(["<html><script>evil()</script></html>"], { type: "image/png" }),
      "fake.png",
    );

    const res = await uploadRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, { body: form }),
      expenseCtx,
    );

    expect(res.status).toBe(415);
    expect(mockedStore.storeReceipt).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads before buffering via streamed limits", async () => {
    // Stream chunks that exceed the upload limit to verify streaming rejection
    const chunk = new Uint8Array(64 * 1024);
    let count = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (count++ < 100) controller.enqueue(chunk);
        else controller.close();
      },
    });

    const req = request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, {
      body: stream as unknown as BodyInit,
      headers: { "content-type": "multipart/form-data; boundary=----boundary" },
    });
    const res = await uploadRoute(req, expenseCtx);

    expect(res.status).toBe(413);
    expect(mockedStore.storeReceipt).not.toHaveBeenCalled();
  });

  it("quarantines infected files and makes them unavailable for download", async () => {
    // Malicious PE header disguised as JPEG
    const peDisguised = new Uint8Array([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00]);
    const form = new FormData();
    form.append("file", new Blob([peDisguised], { type: "image/jpeg" }), "trojan.jpg");

    // The inspectReceiptUpload will sniff it as not an image, or scan will quarantine
    const res = await uploadRoute(
      request(`http://x/api/expenses/${EXPENSE_ID}/receipts`, { body: form }),
      expenseCtx,
    );

    // Either rejected with 415 or stored as quarantined
    if (res.status === 201) {
      const callArgs = mockedStore.storeReceipt.mock.calls[0]?.[1];
      expect(callArgs.inspected.scan.verdict).toBe("quarantine");
    } else {
      expect([400, 415]).toContain(res.status);
    }
  });

  it("never provides download links for quarantined receipts (returns 403)", async () => {
    mockedStore.loadReceipt.mockResolvedValue({
      receipt: {
        id: RECEIPT_ID,
        expenseId: EXPENSE_ID,
        fileName: "suspicious.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        checksum: "c".repeat(64),
        caption: null,
        status: "quarantined",
        uploadedByWallet: PAYER,
        createdAt: new Date().toISOString(),
        retainUntil: new Date().toISOString(),
        removedAt: null,
      },
      storagePath: `quarantine/${EXPENSE_ID}/${RECEIPT_ID}.pdf`,
    });

    const res = await linkRoute(request(`http://x/api/receipts/${RECEIPT_ID}`), receiptCtx);
    expect(res.status).toBe(403);
    expect(mockedStore.createReceiptLink).not.toHaveBeenCalled();
  });

  it("allows download links only for clean, promoted receipts", async () => {
    mockedStore.loadReceipt.mockResolvedValue({
      receipt: {
        id: RECEIPT_ID,
        expenseId: EXPENSE_ID,
        fileName: "receipt.jpg",
        contentType: "image/jpeg",
        sizeBytes: JPEG.length,
        checksum: "d".repeat(64),
        caption: "Dinner",
        status: "active",
        uploadedByWallet: PAYER,
        createdAt: new Date().toISOString(),
        retainUntil: new Date().toISOString(),
        removedAt: null,
      },
      storagePath: `receipts/${EXPENSE_ID}/${RECEIPT_ID}.jpg`,
    });
    mockedStore.createReceiptLink.mockResolvedValue({
      url: "https://signed.storage/receipt.jpg",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const res = await linkRoute(request(`http://x/api/receipts/${RECEIPT_ID}`), receiptCtx);
    expect(res.status).toBe(200);
    expect(mockedStore.createReceiptLink).toHaveBeenCalledWith(
      expect.anything(),
      `receipts/${EXPENSE_ID}/${RECEIPT_ID}.jpg`,
      "receipt.jpg",
    );
  });
});
