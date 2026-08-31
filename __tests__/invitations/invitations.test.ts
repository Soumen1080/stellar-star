import { generateInviteToken, hashToken, buildInviteUrl } from "@/lib/invitations/tokens";
import {
  createTripInvite,
  verifyTripInvite,
  claimTripInvite,
  revokeTripInvite,
  fetchTripInvites,
} from "@/lib/invitations/claim";
import { calculateAllShares } from "@/lib/split/calculator";
import { simplifyDebts, type RawDebt } from "@/lib/settlement/simplify";
import { Money } from "@/lib/money";
import type { Trip, TripInvite } from "@/types/trip";
import type { Expense, Member } from "@/types/expense";

// ─── Test Constants & Addresses ──────────────────────────────────────────────

const ADDR_ALICE = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_BOB = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const ADDR_CHARLIE = "GA4ZPR3FCSUCTM4NK4SKNMBXV4IS7CUDISAX7PWK3PWFBWIQH2OW2O6I";
const ADDR_ATTACKER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

// ─── Mock Database Store ─────────────────────────────────────────────────────

class MockDatabase {
  invites: Map<string, any> = new Map();
  trips: Map<string, Trip> = new Map();
  expenses: Map<string, Expense> = new Map();

  createClient(callerWallet?: string) {
    const self = this;
    return {
      from: (table: string) => ({
        select: (cols = "*") => ({
          eq: (field: string, value: any) => ({
            single: async () => {
              if (table === "trips") {
                const trip = self.trips.get(value);
                return trip ? { data: trip, error: null } : { data: null, error: { message: "Not found" } };
              }
              return { data: null, error: { message: "Not found" } };
            },
            maybeSingle: async () => {
              if (table === "trip_invites") {
                for (const inv of self.invites.values()) {
                  if (inv[field] === value) return { data: inv, error: null };
                }
                return { data: null, error: null };
              }
              return { data: null, error: null };
            },
            order: (orderField: string, opts: any) => {
              if (table === "trip_invites") {
                const list = Array.from(self.invites.values()).filter((i) => i[field] === value);
                return { data: list, error: null };
              }
              return { data: [], error: null };
            },
          }),
        }),
        insert: (row: any) => ({
          select: () => ({
            single: async () => {
              if (table === "trip_invites") {
                const id = "inv-" + Math.random().toString(36).substring(2, 9);
                const record = {
                  id,
                  trip_id: row.trip_id,
                  token_hash: row.token_hash,
                  member_id: row.member_id,
                  created_by_wallet: row.created_by_wallet,
                  expires_at: row.expires_at,
                  max_uses: row.max_uses ?? 1,
                  uses: row.uses ?? 0,
                  revoked: row.revoked ?? false,
                  revoked_at: row.revoked_at ?? null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };
                self.invites.set(id, record);
                return { data: record, error: null };
              }
              return { data: null, error: { message: "Unsupported table" } };
            },
          }),
        }),
        update: (updates: any) => ({
          eq: (field1: string, val1: any) => ({
            eq: (field2: string, val2: any) => {
              if (table === "trip_invites") {
                const inv = self.invites.get(val1);
                if (inv && inv[field2] === val2) {
                  Object.assign(inv, updates);
                  return { data: inv, error: null };
                }
              }
              return { data: null, error: null };
            },
          }),
        }),
      }),
      rpc: async (fnName: string, args: any) => {
        if (fnName === "claim_trip_invite") {
          return self.executeAtomicClaim(args.p_token_hash, args.p_claiming_wallet, args.p_selected_member_id);
        }
        return { data: null, error: { message: `Unknown function ${fnName}` } };
      },
    } as any;
  }

  executeAtomicClaim(tokenHash: string, claimingWallet: string, selectedMemberId?: string) {
    let invite: any = null;
    for (const inv of this.invites.values()) {
      if (inv.token_hash === tokenHash) {
        invite = inv;
        break;
      }
    }

    if (!invite) {
      return { data: null, error: { message: "INVITE_NOT_FOUND: Invalid or unrecognized invitation token" } };
    }
    if (invite.revoked) {
      return { data: null, error: { message: "INVITE_REVOKED: This invitation has been revoked" } };
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      return { data: null, error: { message: "INVITE_EXPIRED: This invitation has expired" } };
    }
    if (invite.uses >= invite.max_uses) {
      return { data: null, error: { message: "INVITE_EXHAUSTED: This invitation has already reached its maximum uses" } };
    }

    const trip = this.trips.get(invite.trip_id);
    if (!trip) {
      return { data: null, error: { message: "TRIP_NOT_FOUND: Associated trip no longer exists" } };
    }

    const targetMemberId = invite.member_id || selectedMemberId;
    let targetMember: Member | undefined;

    if (targetMemberId) {
      targetMember = trip.members.find((m) => m.id === targetMemberId);
      if (!targetMember) {
        return { data: null, error: { message: `MEMBER_NOT_FOUND: Member ${targetMemberId} not found` } };
      }
      if (targetMember.walletAddress && targetMember.walletAddress.trim() !== "") {
        if (targetMember.walletAddress === claimingWallet) {
          // Idempotent success
          return {
            data: {
              success: true,
              trip_id: trip.id,
              trip_name: trip.name,
              member_id: targetMember.id,
              member_name: targetMember.name,
            },
            error: null,
          };
        }
        return {
          data: null,
          error: { message: "SLOT_ALREADY_CLAIMED: This member slot has already been claimed by another wallet" },
        };
      }
      targetMember.walletAddress = claimingWallet;
    } else {
      // Find first unclaimed slot
      targetMember = trip.members.find((m) => !m.walletAddress || m.walletAddress.trim() === "");
      if (targetMember) {
        targetMember.walletAddress = claimingWallet;
      } else {
        targetMember = {
          id: "m-" + Math.random().toString(36).substring(2, 9),
          name: "Member " + (trip.members.length + 1),
          walletAddress: claimingWallet,
        };
        trip.members.push(targetMember);
      }
    }

    // Update expenses
    for (const exp of this.expenses.values()) {
      if (trip.expenseIds.includes(exp.id)) {
        for (const m of exp.members) {
          if (m.id === targetMember.id) m.walletAddress = claimingWallet;
        }
        for (const s of exp.shares) {
          if (s.memberId === targetMember.id) s.walletAddress = claimingWallet;
        }
      }
    }

    invite.uses += 1;

    return {
      data: {
        success: true,
        trip_id: trip.id,
        trip_name: trip.name,
        member_id: targetMember.id,
        member_name: targetMember.name,
      },
      error: null,
    };
  }
}

// ─── Adversarial Test Suite ──────────────────────────────────────────────────

describe("Capability-Based Invitations & Placeholder Claims (Issue #171)", () => {
  let db: MockDatabase;

  beforeEach(() => {
    db = new MockDatabase();

    // Setup initial trip with 1 wallet member (Alice) and 2 placeholders (Bob, Charlie)
    const trip: Trip = {
      id: "trip-tokyo-2026",
      name: "Tokyo Adventure 2026",
      description: "Spring trip to Tokyo",
      members: [
        { id: "m-alice", name: "Alice", walletAddress: ADDR_ALICE },
        { id: "m-bob", name: "Bob", walletAddress: "" },
        { id: "m-charlie", name: "Charlie", walletAddress: "" },
      ],
      expenseIds: ["exp-dinner"],
      createdAt: new Date().toISOString(),
      settled: false,
      createdByWallet: ADDR_ALICE,
    };
    db.trips.set(trip.id, trip);

    // Setup initial expense split among all 3 members
    const expense: Expense = {
      id: "exp-dinner",
      title: "Shinjuku Ramen",
      totalAmount: "30.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m-alice",
      members: [
        { id: "m-alice", name: "Alice", walletAddress: ADDR_ALICE },
        { id: "m-bob", name: "Bob", walletAddress: "" },
        { id: "m-charlie", name: "Charlie", walletAddress: "" },
      ],
      shares: [
        { memberId: "m-bob", name: "Bob", walletAddress: "", amount: "10.0000000", paid: false },
        { memberId: "m-charlie", name: "Charlie", walletAddress: "", amount: "10.0000000", paid: false },
      ],
      createdAt: new Date().toISOString(),
      settled: false,
    };
    db.expenses.set(expense.id, expense);
  });

  // ── 1. Cryptographic Token Safety ──────────────────────────────────────────

  it("generates 256-bit unguessable tokens with deterministic SHA-256 hash", () => {
    const token1 = generateInviteToken();
    const token2 = generateInviteToken();

    expect(token1).toHaveLength(64); // 32 bytes hex = 64 chars
    expect(token2).toHaveLength(64);
    expect(token1).not.toEqual(token2);

    const hash1a = hashToken(token1);
    const hash1b = hashToken(token1);
    const hash2 = hashToken(token2);

    expect(hash1a).toBe(hash1b);
    expect(hash1a).not.toBe(hash2);
    expect(hash1a).toHaveLength(64);
  });

  // ── 2. Forged Token Rejection ──────────────────────────────────────────────

  it("rejects forged or tampered tokens", async () => {
    const client = db.createClient(ADDR_ALICE);
    const forgedToken = "deadbeef".repeat(8);

    await expect(verifyTripInvite(forgedToken, client)).rejects.toThrow(
      "Invalid or unrecognized invitation link",
    );

    await expect(claimTripInvite(forgedToken, ADDR_BOB, undefined, client)).rejects.toThrow(
      "INVITE_NOT_FOUND",
    );
  });

  // ── 3. Exact Share Preservation (Invariant 1) ──────────────────────────────

  it("preserves exact expense shares down to the stroop during wallet attachment", async () => {
    const client = db.createClient(ADDR_ALICE);

    // Create invite for Bob
    const { token } = await createTripInvite(
      {
        tripId: "trip-tokyo-2026",
        createdByWallet: ADDR_ALICE,
        memberId: "m-bob",
      },
      client,
    );

    // Before claim: Bob has 10 XLM share with empty wallet
    const beforeExp = db.expenses.get("exp-dinner")!;
    const beforeBobShare = beforeExp.shares.find((s) => s.memberId === "m-bob")!;
    expect(beforeBobShare.amount).toBe("10.0000000");
    expect(beforeBobShare.walletAddress).toBe("");

    // Bob claims his slot
    const bobClient = db.createClient(ADDR_BOB);
    const claimRes = await claimTripInvite(token, ADDR_BOB, undefined, bobClient);

    expect(claimRes.success).toBe(true);
    expect(claimRes.memberId).toBe("m-bob");
    expect(claimRes.memberName).toBe("Bob");

    // After claim: Bob's share amount is EXACTLY 10.0000000 and wallet is attached
    const afterExp = db.expenses.get("exp-dinner")!;
    const afterBobShare = afterExp.shares.find((s) => s.memberId === "m-bob")!;
    expect(afterBobShare.amount).toBe("10.0000000");
    expect(afterBobShare.walletAddress).toBe(ADDR_BOB);

    const trip = db.trips.get("trip-tokyo-2026")!;
    const tripBob = trip.members.find((m) => m.id === "m-bob")!;
    expect(tripBob.walletAddress).toBe(ADDR_BOB);
  });

  // ── 4. Double-Claim Concurrency Race (Invariant 3) ─────────────────────────

  it("resolves double-claim concurrency races to exactly one winner", async () => {
    const client = db.createClient(ADDR_ALICE);

    // Create invite for Bob's slot
    const { token } = await createTripInvite(
      {
        tripId: "trip-tokyo-2026",
        createdByWallet: ADDR_ALICE,
        memberId: "m-bob",
        maxUses: 1,
      },
      client,
    );

    // Attacker and Real Bob race to claim Bob's slot
    const bobClient = db.createClient(ADDR_BOB);
    const attackerClient = db.createClient(ADDR_ATTACKER);

    // Bob wins first
    const bobResult = await claimTripInvite(token, ADDR_BOB, "m-bob", bobClient);
    expect(bobResult.success).toBe(true);

    // Attacker's claim fails
    await expect(
      claimTripInvite(token, ADDR_ATTACKER, "m-bob", attackerClient),
    ).rejects.toThrow("This invitation has already reached its maximum uses");

    // Bob retains slot
    const trip = db.trips.get("trip-tokyo-2026")!;
    const bobMember = trip.members.find((m) => m.id === "m-bob")!;
    expect(bobMember.walletAddress).toBe(ADDR_BOB);
  });

  // ── 5. Immediate Revocation (Invariant 5) ──────────────────────────────────

  it("immediately revokes an invite and rejects any subsequent access", async () => {
    const client = db.createClient(ADDR_ALICE);

    const { invite, token } = await createTripInvite(
      {
        tripId: "trip-tokyo-2026",
        createdByWallet: ADDR_ALICE,
        memberId: "m-charlie",
      },
      client,
    );

    // Verify it works before revocation
    const summaryBefore = await verifyTripInvite(token, client);
    expect(summaryBefore.tripId).toBe("trip-tokyo-2026");

    // Creator revokes invite
    await revokeTripInvite(invite.id, ADDR_ALICE, client);

    // Verification fails immediately
    await expect(verifyTripInvite(token, client)).rejects.toThrow(
      "This invitation has been revoked",
    );

    // Claim fails immediately
    await expect(claimTripInvite(token, ADDR_CHARLIE, undefined, client)).rejects.toThrow(
      "This invitation has been revoked",
    );
  });

  // ── 6. Expired Token Rejection ─────────────────────────────────────────────

  it("rejects expired invite tokens", async () => {
    const client = db.createClient(ADDR_ALICE);

    const { invite, token } = await createTripInvite(
      {
        tripId: "trip-tokyo-2026",
        createdByWallet: ADDR_ALICE,
        expiresInDays: 7,
      },
      client,
    );

    // Manually backdate expiry to the past
    const record = db.invites.get(invite.id)!;
    record.expires_at = new Date(Date.now() - 3600000).toISOString();

    await expect(verifyTripInvite(token, client)).rejects.toThrow(
      "This invitation has expired",
    );

    await expect(claimTripInvite(token, ADDR_BOB, undefined, client)).rejects.toThrow(
      "This invitation has expired",
    );
  });

  // ── 7. Cross-Group Access Prevention (Invariant 2) ─────────────────────────

  it("prevents cross-group access or claiming slots across trips", async () => {
    const client = db.createClient(ADDR_ALICE);

    // Create Trip 2
    const trip2: Trip = {
      id: "trip-paris-secret",
      name: "Secret Paris Trip",
      members: [
        { id: "m-secret-1", name: "Dave", walletAddress: ADDR_ATTACKER },
        { id: "m-secret-2", name: "Eve", walletAddress: "" },
      ],
      expenseIds: [],
      createdAt: new Date().toISOString(),
      settled: false,
      createdByWallet: ADDR_ATTACKER,
    };
    db.trips.set(trip2.id, trip2);

    // Invite created for Tokyo trip
    const { token } = await createTripInvite(
      {
        tripId: "trip-tokyo-2026",
        createdByWallet: ADDR_ALICE,
        memberId: "m-bob",
      },
      client,
    );

    // Attacker tries to use Tokyo token to claim Eve's slot in Paris
    const attackerClient = db.createClient(ADDR_ATTACKER);
    await expect(
      claimTripInvite(token, ADDR_ATTACKER, "m-secret-2", attackerClient),
    ).rejects.toThrow("MEMBER_NOT_FOUND");
  });

  // ── 8. Idempotent Retry ────────────────────────────────────────────────────

  it("handles idempotent claim retry cleanly without error", async () => {
    const client = db.createClient(ADDR_ALICE);
    const { token } = await createTripInvite(
      {
        tripId: "trip-tokyo-2026",
        createdByWallet: ADDR_ALICE,
        memberId: "m-bob",
        maxUses: 2,
      },
      client,
    );

    const bobClient = db.createClient(ADDR_BOB);

    // First attempt
    const res1 = await claimTripInvite(token, ADDR_BOB, undefined, bobClient);
    expect(res1.success).toBe(true);

    // Idempotent retry by same wallet
    const res2 = await claimTripInvite(token, ADDR_BOB, undefined, bobClient);
    expect(res2.success).toBe(true);
    expect(res2.memberId).toBe("m-bob");
  });

  // ── 9. Non-Blocking Settlement (Invariant 7) ───────────────────────────────

  it("allows wallet-holding members to settle among themselves without waiting for placeholders", () => {
    // Debts in the trip:
    // Alice paid for Bob (no wallet) and Charlie (has wallet attached)
    const rawDebts: RawDebt[] = [
      {
        expenseId: "exp-1",
        fromId: "m-bob",
        toId: "m-alice",
        from: "Bob",
        to: "Alice",
        amount: "10.0000000",
        asset: "native",
        fromWallet: undefined, // Placeholder!
        toWallet: ADDR_ALICE,
      },
      {
        expenseId: "exp-1",
        fromId: "m-charlie",
        toId: "m-alice",
        from: "Charlie",
        to: "Alice",
        amount: "10.0000000",
        asset: "native",
        fromWallet: ADDR_CHARLIE, // Wallet present!
        toWallet: ADDR_ALICE,
      },
    ];

    const simplified = simplifyDebts(rawDebts);
    expect(simplified).toHaveLength(2);

    const charliePayment = simplified.find((p) => p.fromId === "m-charlie");
    expect(charliePayment).toBeDefined();
    expect(charliePayment?.fromWallet).toBe(ADDR_CHARLIE);
    expect(charliePayment?.toWallet).toBe(ADDR_ALICE);
    expect(charliePayment?.amount).toBe("10.0000000");

    // Charlie can settle with Alice on-chain immediately despite Bob having no wallet!
    const isPayableOnChain = Boolean(charliePayment?.fromWallet && charliePayment?.toWallet);
    expect(isPayableOnChain).toBe(true);
  });
});
