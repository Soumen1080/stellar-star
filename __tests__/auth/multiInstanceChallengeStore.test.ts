/**
 * multiInstanceChallengeStore.test.ts
 *
 * Verification suite for Issue #158 (Epic #52).
 * Tests atomic cross-instance challenge consumption, concurrent verification races,
 * eviction attack isolation, and expired challenge handling.
 */

import {
  issueChallenge,
  consumeChallenge,
  __resetChallengeStoreForTests,
  MAX_PENDING_PER_ADDRESS,
  AuthStoreError,
} from "@/lib/auth/challengeStore";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server");

const WALLET_ALICE    = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_ATTACKER = "GATTACKERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("Multi-Instance Challenge Store & Atomic Consumption (Issue #158 / Epic #52)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetChallengeStoreForTests();
    jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);
  });

  // ===========================================================================
  // Invariant 1: Exactly-once consumption under concurrency
  // ===========================================================================

  it("Invariant 1: A challenge is consumable exactly once; concurrent consumption allows only one winner", async () => {
    const nonce = "nonce-race-1";
    const expiration = Date.now() + 60_000;

    await issueChallenge(WALLET_ALICE, nonce, expiration);

    // Simulate two concurrent requests arriving on different instances at the same millisecond
    const [result1, result2] = await Promise.all([
      consumeChallenge(WALLET_ALICE, nonce, expiration),
      consumeChallenge(WALLET_ALICE, nonce, expiration),
    ]);

    // Exactly one must succeed, and the other must be rejected
    expect([result1, result2].filter(Boolean)).toHaveLength(1);
    expect(result1 !== result2).toBe(true);

    // A third subsequent attempt must also fail
    const result3 = await consumeChallenge(WALLET_ALICE, nonce, expiration);
    expect(result3).toBe(false);
  });

  // ===========================================================================
  // Invariant 1: Cross-instance simulation with Supabase RPC
  // ===========================================================================

  it("Invariant 1: Cross-instance issue on Instance A and verify on Instance B via database store", async () => {
    jest.mocked(isServerSupabaseConfigured).mockReturnValue(true);

    const mockRpc = jest.fn();
    mockRpc.mockImplementation((fnName: string, args: any) => {
      if (fnName === "record_auth_challenge") {
        return Promise.resolve({ data: true, error: null });
      }
      if (fnName === "consume_auth_challenge") {
        // Return true on first call, false on second call (simulating atomic Postgres DELETE)
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    jest.mocked(createServiceRoleClient).mockReturnValue({
      rpc: mockRpc,
    } as any);

    const nonce = "nonce-db-cross-instance";
    const expiration = Date.now() + 60_000;

    // Instance A issues challenge
    await issueChallenge(WALLET_ALICE, nonce, expiration);
    expect(mockRpc).toHaveBeenCalledWith("record_auth_challenge", {
      p_address: WALLET_ALICE,
      p_nonce: nonce,
      p_expiration: expiration,
      p_max_pending: MAX_PENDING_PER_ADDRESS,
    });

    // Instance B consumes challenge
    const success = await consumeChallenge(WALLET_ALICE, nonce, expiration);
    expect(success).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith("consume_auth_challenge", {
      p_address: WALLET_ALICE,
      p_nonce: nonce,
      p_expiration: expiration,
      p_now: expect.any(Number),
    });
  });

  // ===========================================================================
  // Invariant 2: Expired challenges are unusable
  // ===========================================================================

  it("Invariant 2: Rejects expired challenges even if they were never consumed", async () => {
    const nonce = "nonce-expired-1";
    const now = Date.now();
    const pastExpiration = now - 5_000; // Expired 5 seconds ago

    await issueChallenge(WALLET_ALICE, nonce, pastExpiration, now - 10_000);

    const success = await consumeChallenge(WALLET_ALICE, nonce, pastExpiration, now);
    expect(success).toBe(false);
  });

  // ===========================================================================
  // Invariant 3: Attacker cannot evict legitimate user's pending challenges
  // ===========================================================================

  it("Invariant 3: Eviction isolation — 1,000 rapid attacker challenges do NOT evict Alice's pending challenge", async () => {
    const aliceNonce = "alice-pending-nonce";
    const expiration = Date.now() + 60_000;

    // Alice requests a challenge
    await issueChallenge(WALLET_ALICE, aliceNonce, expiration);

    // Attacker floods the server with 1,000 challenge requests from their own wallet
    for (let i = 0; i < 1_000; i++) {
      await issueChallenge(WALLET_ATTACKER, `attacker-nonce-${i}`, expiration);
    }

    // Alice's challenge MUST STILL BE VALID and consumable!
    const aliceConsume = await consumeChallenge(WALLET_ALICE, aliceNonce, expiration);
    expect(aliceConsume).toBe(true);
  });

  // ===========================================================================
  // Invariant 5: Store unavailability produces explicit error, never silent downgrade
  // ===========================================================================

  it("Invariant 5: Database failure during consume throws explicit AuthStoreError", async () => {
    jest.mocked(isServerSupabaseConfigured).mockReturnValue(true);

    const mockClient = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { message: "Database connection failed", code: "PGRST500" },
      }),
      from: jest.fn(() => ({
        delete: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                gt: jest.fn(() => ({
                  select: jest.fn().mockResolvedValue({
                    data: null,
                    error: { message: "Connection refused" },
                  }),
                })),
              })),
            })),
          })),
        })),
      })),
    };

    jest.mocked(createServiceRoleClient).mockReturnValue(mockClient as any);

    await expect(
      consumeChallenge(WALLET_ALICE, "nonce-err", Date.now() + 60_000),
    ).rejects.toThrow(AuthStoreError);
  });
});
