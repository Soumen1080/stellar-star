import {
  createUploadIntent,
  loadUploadIntent,
  recordQuarantinedIntent,
  recordPromotedIntent,
  cleanupAbandonedUploads,
  ReceiptIntentError,
  DEFAULT_UPLOAD_INTENT_TTL_SECONDS,
} from "@/lib/receipts/intent";
import { RECEIPT_BUCKET } from "@/lib/receipts/policy";

const EXPENSE_ID = "11111111-1111-4111-8111-111111111111";
const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

function mockSupabase(initialRows: Record<string, unknown>[] = []) {
  const rows = [...initialRows];
  const storageRemove = jest.fn().mockResolvedValue({ error: null });

  const client = {
    storage: {
      from: jest.fn(() => ({
        remove: storageRemove,
      })),
    },
    from: jest.fn((table: string) => {
      if (table !== "receipt_upload_intents") return {} as never;

      let filtered = [...rows];
      let pendingPatch: Record<string, unknown> | null = null;

      const applyPatch = () => {
        if (pendingPatch) {
          filtered.forEach((r) => {
            Object.assign(r, pendingPatch);
          });
          pendingPatch = null;
        }
      };

      const query: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((col: string, val: unknown) => {
          filtered = filtered.filter((r) => r[col] === val);
          return query;
        }),
        in: jest.fn((col: string, vals: unknown[]) => {
          filtered = filtered.filter((r) => vals.includes(r[col]));
          return query;
        }),
        lte: jest.fn((col: string, val: string) => {
          filtered = filtered.filter((r) => String(r[col]) <= val);
          return query;
        }),
        limit: jest.fn((n: number) => {
          filtered = filtered.slice(0, n);
          return query;
        }),
        maybeSingle: jest.fn(async () => {
          applyPatch();
          return { data: filtered[0] ?? null, error: null };
        }),
        single: jest.fn(async () => {
          applyPatch();
          return { data: filtered[0] ?? null, error: filtered[0] ? null : new Error("Not found") };
        }),
        insert: jest.fn((row: Record<string, unknown>) => {
          const created = {
            id: row.id ?? crypto.randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...row,
          };
          rows.push(created);
          filtered = [created];
          return query;
        }),
        update: jest.fn((patch: Record<string, unknown>) => {
          pendingPatch = patch;
          return query;
        }),
        then: (resolve: (v: unknown) => void) => {
          applyPatch();
          return Promise.resolve(resolve({ data: filtered, error: null }));
        },
      };
      return query;
    }),
  };

  return { client: client as never, storageRemove, rows };
}

describe("receipt upload intents (#451)", () => {
  it("creates a short-lived pending upload intent with expiry", async () => {
    const { client } = mockSupabase();
    const now = new Date("2026-11-24T12:00:00Z");
    const intent = await createUploadIntent(client, {
      expenseId: EXPENSE_ID,
      wallet: WALLET,
      idempotencyKey: "key-12345",
      ttlSeconds: 900,
      now,
    });

    expect(intent.status).toBe("pending");
    expect(intent.expenseId).toBe(EXPENSE_ID);
    expect(intent.wallet).toBe(WALLET);
    expect(intent.idempotencyKey).toBe("key-12345");
    expect(intent.expiresAt).toBe(new Date(now.getTime() + 900 * 1000).toISOString());
  });

  it("replays the existing intent on idempotent retry", async () => {
    const { client } = mockSupabase();
    const now = new Date("2026-11-24T12:00:00Z");
    const first = await createUploadIntent(client, {
      expenseId: EXPENSE_ID,
      wallet: WALLET,
      idempotencyKey: "key-retry",
      now,
    });
    const second = await createUploadIntent(client, {
      expenseId: EXPENSE_ID,
      wallet: WALLET,
      idempotencyKey: "key-retry",
      now,
    });

    expect(second.id).toBe(first.id);
  });

  it("detects key conflicts when parameters mismatch", async () => {
    const { client } = mockSupabase();
    await createUploadIntent(client, {
      expenseId: EXPENSE_ID,
      wallet: WALLET,
      idempotencyKey: "key-conflict",
    });

    await expect(
      createUploadIntent(client, {
        expenseId: EXPENSE_ID,
        wallet: "GDIFFERENTWALLET",
        idempotencyKey: "key-conflict",
      }),
    ).rejects.toThrow(ReceiptIntentError);
  });

  it("records a quarantined intent transition", async () => {
    const { client } = mockSupabase([
      {
        id: "intent-1",
        expense_id: EXPENSE_ID,
        wallet: WALLET,
        idempotency_key: "key-1",
        status: "pending",
        expires_at: new Date(Date.now() + 900000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    const updated = await recordQuarantinedIntent(client, {
      intentId: "intent-1",
      storagePath: `quarantine/${EXPENSE_ID}/intent-1.jpg`,
      fileName: "malicious.jpg",
      contentType: "image/jpeg",
      sizeBytes: 1024,
      checksum: "a".repeat(64),
      caption: null,
      scanResult: { verdict: "quarantine", reasons: ["embedded_script"] },
    });

    expect(updated.status).toBe("quarantined");
    expect(updated.storagePath).toBe(`quarantine/${EXPENSE_ID}/intent-1.jpg`);
    expect(updated.scanResult.verdict).toBe("quarantine");
  });

  it("records a promoted intent transition with receipt ID and promoted path", async () => {
    const { client } = mockSupabase([
      {
        id: "intent-2",
        expense_id: EXPENSE_ID,
        wallet: WALLET,
        idempotency_key: "key-2",
        status: "pending",
        expires_at: new Date(Date.now() + 900000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    const updated = await recordPromotedIntent(client, {
      intentId: "intent-2",
      receiptId: "receipt-uuid",
      promotedPath: `receipts/${EXPENSE_ID}/receipt-uuid.jpg`,
      fileName: "clean.jpg",
      contentType: "image/jpeg",
      sizeBytes: 2048,
      checksum: "b".repeat(64),
      caption: "Groceries",
      scanResult: { verdict: "clean", reasons: [] },
    });

    expect(updated.status).toBe("promoted");
    expect(updated.receiptId).toBe("receipt-uuid");
    expect(updated.promotedPath).toBe(`receipts/${EXPENSE_ID}/receipt-uuid.jpg`);
  });

  it("cleans up abandoned upload intents and removes orphaned quarantine files", async () => {
    const now = new Date("2026-11-24T14:00:00Z");
    const expiredPast = new Date(now.getTime() - 60000).toISOString();
    const future = new Date(now.getTime() + 600000).toISOString();

    const { client, storageRemove, rows } = mockSupabase([
      {
        id: "abandoned-1",
        expense_id: EXPENSE_ID,
        wallet: WALLET,
        idempotency_key: "k1",
        status: "pending",
        storage_path: `quarantine/${EXPENSE_ID}/staged1.jpg`,
        expires_at: expiredPast,
        created_at: expiredPast,
        updated_at: expiredPast,
      },
      {
        id: "abandoned-2",
        expense_id: EXPENSE_ID,
        wallet: WALLET,
        idempotency_key: "k2",
        status: "quarantined",
        storage_path: `quarantine/${EXPENSE_ID}/staged2.jpg`,
        expires_at: expiredPast,
        created_at: expiredPast,
        updated_at: expiredPast,
      },
      {
        id: "active-intent",
        expense_id: EXPENSE_ID,
        wallet: WALLET,
        idempotency_key: "k3",
        status: "pending",
        storage_path: `quarantine/${EXPENSE_ID}/active.jpg`,
        expires_at: future,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ]);

    const result = await cleanupAbandonedUploads(client, { now });

    expect(result.cleaned).toBe(2);
    expect(result.failed).toBe(0);
    expect(storageRemove).toHaveBeenCalledWith([`quarantine/${EXPENSE_ID}/staged1.jpg`]);
    expect(storageRemove).toHaveBeenCalledWith([`quarantine/${EXPENSE_ID}/staged2.jpg`]);
    expect(storageRemove).not.toHaveBeenCalledWith([`quarantine/${EXPENSE_ID}/active.jpg`]);

    const intent1 = rows.find((r) => r.id === "abandoned-1");
    expect(intent1?.status).toBe("abandoned");
    const active = rows.find((r) => r.id === "active-intent");
    expect(active?.status).toBe("pending");
  });
});
