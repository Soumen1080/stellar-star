jest.mock("@/lib/supabase/session", () => ({ getAccessToken: () => "session-token" }));

import {
  LINK_EXPIRY_MARGIN_MS,
  ReceiptRequestError,
  freshReceiptLink,
  isReceiptLinkUsable,
} from "@/lib/receipts/client";
import type { ReceiptLink } from "@/types/receipt";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const link = (msFromNow: number, url = "https://old"): ReceiptLink => ({
  url,
  expiresAt: new Date(NOW + msFromNow).toISOString(),
});

function okFetch(body: unknown) {
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }) as unknown as typeof fetch;
}

describe("expired-link handling", () => {
  it("treats links at or near expiry as unusable", () => {
    expect(isReceiptLinkUsable(link(60_000), NOW)).toBe(true);
    expect(isReceiptLinkUsable(link(LINK_EXPIRY_MARGIN_MS), NOW)).toBe(false);
    expect(isReceiptLinkUsable(link(-1), NOW)).toBe(false);
    expect(isReceiptLinkUsable({ url: "x", expiresAt: "garbage" }, NOW)).toBe(false);
    expect(isReceiptLinkUsable(null, NOW)).toBe(false);
  });

  it("reuses a cached link while it is still valid", async () => {
    const cache = new Map([["r1", link(30_000)]]);
    const fetchImpl = okFetch({});
    const result = await freshReceiptLink("r1", cache, { now: NOW, fetchImpl });
    expect(result.url).toBe("https://old");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-signs instead of opening an expired link", async () => {
    const cache = new Map([["r1", link(-10_000)]]);
    const fresh = link(60_000, "https://fresh");
    const fetchImpl = okFetch({ data: fresh });

    const result = await freshReceiptLink("r1", cache, { now: NOW, fetchImpl });

    expect(result.url).toBe("https://fresh");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/receipts/r1",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer session-token" }) }),
    );
    expect(cache.get("r1")).toEqual(fresh);
  });

  it("surfaces access denial from the server and drops the stale link", async () => {
    const cache = new Map([["r1", link(-10_000)]]);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "Receipt not found." }),
    }) as unknown as typeof fetch;

    await expect(freshReceiptLink("r1", cache, { now: NOW, fetchImpl })).rejects.toBeInstanceOf(ReceiptRequestError);
    expect(cache.has("r1")).toBe(false);
  });
});
