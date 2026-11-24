import crypto from "node:crypto";
import { NextRequest } from "next/server";
import {
  encryptObjectPayload,
  decryptObjectPayload,
  rotateObjectKey,
  cryptoEraseObject,
  cryptoEraseKey,
  saveObjectEncryptionMetadata,
  loadObjectEncryptionMetadata,
  logObjectAccess,
  ObjectEncryptionError,
} from "@/lib/security/objectEncryption";
import { POST as rotateRoute } from "@/app/api/admin/objects/rotate/route";
import { POST as cryptoEraseRoute } from "@/app/api/admin/objects/crypto-erase/route";
import { GET as metadataRoute } from "@/app/api/receipts/[receiptId]/metadata/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => true,
  createServerClientForToken: () => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({ data: null, error: null })),
    })),
  }),
  createServiceRoleClient: () => ({
    from: jest.fn(() => ({
      insert: jest.fn().mockResolvedValue({ error: null }),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({ data: null, error: null })),
    })),
  }),
}));

const WALLET_OWNER = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const WALLET_ATTACKER = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const EXPENSE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const BUCKET = "expense-receipts";
const STORAGE_PATH = `receipts/${EXPENSE_ID}/${RECEIPT_ID}.jpg`;

const KEY_1_MATERIAL = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_2_MATERIAL = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function mockSupabase() {
  const metadataRows: Record<string, any>[] = [];
  const logRows: Record<string, any>[] = [];
  const storageObjects: Record<string, Buffer> = {};
  const keyRows: Record<string, any>[] = [
    {
      key_id: "k-2026-v1",
      algorithm: "aes-256-gcm",
      status: "active",
      key_material: KEY_1_MATERIAL,
      created_at: new Date().toISOString(),
      activated_at: new Date().toISOString(),
      revoked_at: null,
      erased_at: null,
    },
    {
      key_id: "k-2026-v2",
      algorithm: "aes-256-gcm",
      status: "active",
      key_material: KEY_2_MATERIAL,
      created_at: new Date().toISOString(),
      activated_at: new Date().toISOString(),
      revoked_at: null,
      erased_at: null,
    },
  ];

  const client = {
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn(async (path: string, bytes: any) => {
          storageObjects[path] = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          return { error: null };
        }),
        download: jest.fn(async (path: string) => {
          const buf = storageObjects[path];
          if (!buf) return { data: null, error: new Error("File not found") };
          return {
            data: {
              arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            },
            error: null,
          };
        }),
        remove: jest.fn(async (paths: string[]) => {
          for (const p of paths) delete storageObjects[p];
          return { error: null };
        }),
      })),
    },
    from: jest.fn((table: string) => {
      let activeRows =
        table === "private_object_metadata"
          ? metadataRows
          : table === "object_access_logs"
          ? logRows
          : table === "object_encryption_keys"
          ? keyRows
          : [];

      let filtered = [...activeRows];

      const query: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((col: string, val: any) => {
          filtered = filtered.filter((r) => r[col] === val);
          return query;
        }),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn((n: number) => {
          filtered = filtered.slice(0, n);
          return query;
        }),
        maybeSingle: jest.fn(async () => ({ data: filtered[0] ?? null, error: null })),
        single: jest.fn(async () => ({ data: filtered[0] ?? null, error: filtered[0] ? null : new Error("Not found") })),
        insert: jest.fn(async (row: any) => {
          const created = { id: row.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
          activeRows.push(created);
          filtered = [created];
          return { data: created, error: null };
        }),
        upsert: jest.fn((row: any) => {
          const idx = activeRows.findIndex((r) => r.storage_path === row.storage_path);
          const updated = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
          if (idx >= 0) activeRows[idx] = { ...activeRows[idx], ...updated };
          else activeRows.push(updated);
          filtered = [updated];
          return query;
        }),
        update: jest.fn((patch: any) => {
          return {
            eq: jest.fn((col: string, val: any) => {
              activeRows.forEach((r) => {
                if (r[col] === val) Object.assign(r, patch);
              });
              return { error: null };
            }),
          };
        }),
      };
      return query;
    }),
  };

  return { client: client as any, metadataRows, logRows, storageObjects, keyRows };
}

describe("managed object encryption and key rotation (#453)", () => {
  it("encrypts and decrypts payloads with AES-256-GCM and binds storagePath via AAD", () => {
    const plaintext = Buffer.from("Sensitive Receipt Data: John Doe $145.00");
    const enc = encryptObjectPayload({
      bytes: plaintext,
      keyMaterial: KEY_1_MATERIAL,
      keyId: "k-2026-v1",
      storagePath: STORAGE_PATH,
    });

    expect(enc.ciphertext).not.toEqual(plaintext);
    expect(enc.iv).toHaveLength(24); // 12 bytes = 24 hex chars
    expect(enc.authTag).toHaveLength(32); // 16 bytes = 32 hex chars

    // Decrypt with matching key and storagePath
    const decrypted = decryptObjectPayload({
      ciphertext: enc.ciphertext,
      keyMaterial: KEY_1_MATERIAL,
      keyId: "k-2026-v1",
      storagePath: STORAGE_PATH,
      iv: enc.iv,
      authTag: enc.authTag,
    });
    expect(decrypted.toString()).toBe("Sensitive Receipt Data: John Doe $145.00");

    // Replanting check: tampering storagePath in AAD causes decryption failure
    expect(() =>
      decryptObjectPayload({
        ciphertext: enc.ciphertext,
        keyMaterial: KEY_1_MATERIAL,
        keyId: "k-2026-v1",
        storagePath: "receipts/different-expense/different-receipt.jpg",
        iv: enc.iv,
        authTag: enc.authTag,
      }),
    ).toThrow(ObjectEncryptionError);
  });

  it("staging rotation succeeds: re-encrypts stored object under a new key and updates metadata", async () => {
    const { client, storageObjects, metadataRows, logRows } = mockSupabase();
    const requestId = "req-rot-100";
    const plaintext = Buffer.from("Important Invoice Details");

    // Initial encryption under key 1
    const enc1 = encryptObjectPayload({
      bytes: plaintext,
      keyMaterial: KEY_1_MATERIAL,
      keyId: "k-2026-v1",
      storagePath: STORAGE_PATH,
    });
    storageObjects[STORAGE_PATH] = enc1.ciphertext;

    await saveObjectEncryptionMetadata(client, {
      bucket: BUCKET,
      storagePath: STORAGE_PATH,
      ownerWallet: WALLET_OWNER,
      expenseId: EXPENSE_ID,
      keyId: "k-2026-v1",
      iv: enc1.iv,
      authTag: enc1.authTag,
      ciphertextSha256: enc1.ciphertextSha256,
      plaintextSha256: enc1.plaintextSha256,
      byteSize: enc1.byteSize,
    });

    // Execute staging rotation to target key 2
    const rotateResult = await rotateObjectKey(client, {
      bucket: BUCKET,
      storagePath: STORAGE_PATH,
      targetKeyId: "k-2026-v2",
      actorWallet: WALLET_OWNER,
      requestId,
    });

    expect(rotateResult.success).toBe(true);
    expect(rotateResult.oldKeyId).toBe("k-2026-v1");
    expect(rotateResult.newKeyId).toBe("k-2026-v2");

    // Verify stored object now decrypts under key 2
    const updatedMeta = await loadObjectEncryptionMetadata(client, STORAGE_PATH);
    expect(updatedMeta?.key_id).toBe("k-2026-v2");
    expect(updatedMeta?.iv).not.toBe(enc1.iv); // Fresh IV generated

    const decrypted = decryptObjectPayload({
      ciphertext: storageObjects[STORAGE_PATH],
      keyMaterial: KEY_2_MATERIAL,
      keyId: "k-2026-v2",
      storagePath: STORAGE_PATH,
      iv: updatedMeta!.iv,
      authTag: updatedMeta!.auth_tag,
    });
    expect(decrypted.toString()).toBe("Important Invoice Details");

    // Verify access log correlates request ID
    const rotateLog = logRows.find((l) => l.action === "rotate");
    expect(rotateLog).toBeDefined();
    expect(rotateLog.request_id).toBe(requestId);
    expect(rotateLog.old_key_id).toBe("k-2026-v1");
    expect(rotateLog.key_id).toBe("k-2026-v2");
  });

  it("crypto-erasure renders an object permanently unrecoverable", async () => {
    const { client, storageObjects, metadataRows, logRows } = mockSupabase();
    const requestId = "req-erase-200";

    const enc = encryptObjectPayload({
      bytes: Buffer.from("Confidential Payroll"),
      keyMaterial: KEY_1_MATERIAL,
      keyId: "k-2026-v1",
      storagePath: STORAGE_PATH,
    });
    storageObjects[STORAGE_PATH] = enc.ciphertext;

    await saveObjectEncryptionMetadata(client, {
      bucket: BUCKET,
      storagePath: STORAGE_PATH,
      ownerWallet: WALLET_OWNER,
      expenseId: EXPENSE_ID,
      keyId: "k-2026-v1",
      iv: enc.iv,
      authTag: enc.authTag,
      ciphertextSha256: enc.ciphertextSha256,
      plaintextSha256: enc.plaintextSha256,
      byteSize: enc.byteSize,
    });

    // Perform crypto-erasure of the object
    await cryptoEraseObject(client, {
      bucket: BUCKET,
      storagePath: STORAGE_PATH,
      actorWallet: WALLET_OWNER,
      requestId,
    });

    // Object is removed from storage
    expect(storageObjects[STORAGE_PATH]).toBeUndefined();

    // Metadata is zeroed/erased
    const erasedMeta = await loadObjectEncryptionMetadata(client, STORAGE_PATH);
    expect(erasedMeta?.status).toBe("erased");
    expect(erasedMeta?.iv).toBe("0".repeat(24));
    expect(erasedMeta?.auth_tag).toBe("0".repeat(32));

    // Access log recorded with request ID
    const eraseLog = logRows.find((l) => l.action === "crypto_erase");
    expect(eraseLog).toBeDefined();
    expect(eraseLog.request_id).toBe(requestId);
    expect(eraseLog.status).toBe("erased");

    // Attempting rotation on erased object throws 410
    await expect(
      rotateObjectKey(client, {
        bucket: BUCKET,
        storagePath: STORAGE_PATH,
        targetKeyId: "k-2026-v2",
        actorWallet: WALLET_OWNER,
        requestId: "req-rot-fail",
      }),
    ).rejects.toThrow(ObjectEncryptionError);
  });

  it("key crypto-erasure permanently revokes decryption of all objects under that key", async () => {
    const { client, keyRows, logRows } = mockSupabase();
    const requestId = "req-key-erase-300";

    await cryptoEraseKey(client, {
      keyId: "k-2026-v1",
      actorWallet: "staff:operator",
      requestId,
    });

    const key = keyRows.find((k) => k.key_id === "k-2026-v1");
    expect(key.status).toBe("erased");
    expect(key.key_material).toBeNull();

    // Decrypting with null key material throws 410 KEY_ERASED
    expect(() =>
      decryptObjectPayload({
        ciphertext: Buffer.from("any"),
        keyMaterial: null,
        keyId: "k-2026-v1",
        storagePath: STORAGE_PATH,
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
      }),
    ).toThrow(ObjectEncryptionError);

    const log = logRows.find((l) => l.key_id === "k-2026-v1" && l.action === "crypto_erase");
    expect(log).toBeDefined();
    expect(log.request_id).toBe(requestId);
  });
});

describe("object encryption routes and access control (#453)", () => {
  it("POST /api/admin/objects/rotate rotates key and correlates request ID", async () => {
    const req = new NextRequest("http://x/api/admin/objects/rotate", {
      method: "POST",
      headers: {
        "x-staff-secret": "test-staff-secret",
        "x-request-id": "req-admin-rot-400",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucket: BUCKET,
        storagePath: STORAGE_PATH,
        targetKeyId: "k-2026-v2",
      }),
    });

    const res = await rotateRoute(req);
    expect(res.headers.get("x-request-id")).toBe("req-admin-rot-400");
  });

  it("GET /api/receipts/:id/metadata rejects unauthorized caller with 403", async () => {
    const req = new NextRequest(`http://x/api/receipts/${RECEIPT_ID}/metadata`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${signWalletSession(WALLET_ATTACKER)}`,
        "x-request-id": "req-attacker-500",
      },
    });

    const res = await metadataRoute(req, { params: Promise.resolve({ receiptId: RECEIPT_ID }) });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBe("req-attacker-500");
  });
});
