/**
 * Tests for OCR quota enforcement (issue #452).
 */

import { checkQuota, getQuotaUsage, OcrQuotaError } from "@/lib/receipts/ocr/quota";

// ── Mock Supabase client ────────────────────────────────────────────────────
function mockClient({
  quotaConfig = [] as Array<{ scope: string; max_jobs: number; window_seconds: number }>,
  jobCounts = {} as Record<string, number>,
} = {}) {
  return {
    from: (table: string) => {
      if (table === "ocr_quota_config") {
        return {
          select: () => ({
            eq: (_col: string, scope: string) => ({
              limit: () => ({
                maybeSingle: async () => {
                  const row = quotaConfig.find((c) => c.scope === scope);
                  return { data: row ?? null, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "ocr_jobs") {
        return {
          select: (_cols: string, _opts: unknown) => ({
            eq: (_col: string, value: string) => ({
              gte: () => ({
                then: async (resolve: (v: { count: number; error: null }) => void) =>
                  resolve({ count: jobCounts[value] ?? 0, error: null }),
              }),
            }),
          }),
        };
      }
      return {};
    },
  } as never;
}

describe("OCR quota enforcement", () => {
  it("allows enqueue when under both user and trip limits", async () => {
    const client = mockClient({
      quotaConfig: [
        { scope: "user", max_jobs: 10, window_seconds: 3600 },
        { scope: "trip", max_jobs: 20, window_seconds: 3600 },
      ],
      jobCounts: { GWALLET: 5, "trip-1": 8 },
    });
    // Should not throw.
    await expect(
      checkQuota(client, { wallet: "GWALLET", tripId: "trip-1" }),
    ).resolves.toBeUndefined();
  });

  it("rejects when user quota is exceeded", async () => {
    const client = mockClient({
      quotaConfig: [{ scope: "user", max_jobs: 5, window_seconds: 3600 }],
      jobCounts: { GWALLET: 5 },
    });
    await expect(
      checkQuota(client, { wallet: "GWALLET", tripId: null }),
    ).rejects.toThrow(OcrQuotaError);
  });

  it("rejects when trip quota is exceeded", async () => {
    const client = mockClient({
      quotaConfig: [
        { scope: "user", max_jobs: 100, window_seconds: 3600 },
        { scope: "trip", max_jobs: 3, window_seconds: 3600 },
      ],
      jobCounts: { GWALLET: 1, "trip-1": 3 },
    });
    await expect(
      checkQuota(client, { wallet: "GWALLET", tripId: "trip-1" }),
    ).rejects.toThrow(OcrQuotaError);
  });

  it("skips trip quota when tripId is null", async () => {
    const client = mockClient({
      quotaConfig: [{ scope: "user", max_jobs: 10, window_seconds: 3600 }],
      jobCounts: { GWALLET: 2 },
    });
    await expect(
      checkQuota(client, { wallet: "GWALLET", tripId: null }),
    ).resolves.toBeUndefined();
  });

  it("uses default limits when config table is empty", async () => {
    const client = mockClient({
      quotaConfig: [],
      jobCounts: { GWALLET: 15 },
    });
    // Default user limit is 20 — 15 is under.
    await expect(
      checkQuota(client, { wallet: "GWALLET", tripId: null }),
    ).resolves.toBeUndefined();
  });

  it("OcrQuotaError has status 429 and retryAfterSeconds", async () => {
    const client = mockClient({
      quotaConfig: [{ scope: "user", max_jobs: 1, window_seconds: 3600 }],
      jobCounts: { GWALLET: 1 },
    });
    try {
      await checkQuota(client, { wallet: "GWALLET", tripId: null });
      fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcrQuotaError);
      expect((err as OcrQuotaError).status).toBe(429);
      expect((err as OcrQuotaError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});

describe("getQuotaUsage", () => {
  it("returns user and trip usage", async () => {
    const client = mockClient({
      quotaConfig: [
        { scope: "user", max_jobs: 20, window_seconds: 3600 },
        { scope: "trip", max_jobs: 50, window_seconds: 3600 },
      ],
      jobCounts: { GWALLET: 7, "trip-1": 12 },
    });
    const usage = await getQuotaUsage(client, "GWALLET", "trip-1");
    expect(usage.user.used).toBe(7);
    expect(usage.user.limit).toBe(20);
    expect(usage.trip).not.toBeNull();
    expect(usage.trip!.used).toBe(12);
    expect(usage.trip!.limit).toBe(50);
  });

  it("returns null for trip when tripId is null", async () => {
    const client = mockClient({
      quotaConfig: [{ scope: "user", max_jobs: 20, window_seconds: 3600 }],
      jobCounts: { GWALLET: 3 },
    });
    const usage = await getQuotaUsage(client, "GWALLET", null);
    expect(usage.trip).toBeNull();
  });
});
