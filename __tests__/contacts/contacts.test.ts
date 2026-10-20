/**
 * Reusable contacts & member profiles (#322).
 *
 *  - Duplicates are detected by canonical wallet, never by display name.
 *  - An unverified (typed-in) wallet is never presented as owned.
 *  - Wallet changes notify active trips first and never touch history.
 */

import fs from "node:fs";
import path from "node:path";
import {
  affectedActiveTrips,
  canApplyWalletChange,
  contactToMember,
  findDuplicateByWallet,
  findDuplicateGroups,
  normalizeContactInput,
  validateContactInput,
  walletChangesForTrip,
  walletTrust,
} from "@/lib/contacts/contacts";
import { contactErrorMessage, rowToContact } from "@/lib/contacts/queries";
import type { Contact, ContactWalletChange } from "@/types/contact";
import type { Trip } from "@/types/trip";

const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const OWNER = "GA4ZPR3FCSUCTM4NK4SKNMBXV4IS7CUDISAX7PWK3PWFBWIQH2OW2O6I";

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    ownerWallet: OWNER,
    displayName: "Sam",
    walletVerified: false,
    hasPendingClaim: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("duplicate detection uses the canonical wallet, not the name", () => {
  it("treats two contacts with the same name but different wallets as different people", () => {
    const contacts = [contact({ id: "1", walletAddress: ADDR_A }), contact({ id: "2", walletAddress: ADDR_B })];
    expect(findDuplicateGroups(contacts)).toEqual([]);
  });

  it("treats different names with the same wallet (any case/whitespace) as duplicates", () => {
    const contacts = [
      contact({ id: "1", displayName: "Sam", walletAddress: ADDR_A }),
      contact({ id: "2", displayName: "Samantha", walletAddress: `  ${ADDR_A.toLowerCase()} ` }),
    ];
    expect(findDuplicateGroups(contacts).map((g) => g.map((c) => c.id))).toEqual([["1", "2"]]);
    expect(findDuplicateByWallet(contacts, ADDR_A.toLowerCase(), "1")?.id).toBe("2");
  });

  it("never considers wallet-less contacts duplicates of each other", () => {
    expect(findDuplicateGroups([contact({ id: "1" }), contact({ id: "2" })])).toEqual([]);
  });

  it("rejects a new contact whose wallet is already saved, but allows the same name", () => {
    const existing = [contact({ id: "1", displayName: "Sam", walletAddress: ADDR_A })];
    expect(validateContactInput({ displayName: "Someone else", walletAddress: ADDR_A.toLowerCase() }, existing).walletAddress)
      .toMatch(/already have a contact/);
    expect(validateContactInput({ displayName: "Sam", walletAddress: ADDR_B }, existing)).toEqual({});
  });

  it("does not flag the contact being edited as its own duplicate", () => {
    const existing = [contact({ id: "1", walletAddress: ADDR_A })];
    expect(validateContactInput({ displayName: "Sam", walletAddress: ADDR_A }, existing, "1")).toEqual({});
  });
});

describe("validation and normalisation", () => {
  it("requires a name and a valid optional wallet", () => {
    const errors = validateContactInput({ displayName: "  ", walletAddress: "not-a-wallet" });
    expect(errors.displayName).toBeDefined();
    expect(errors.walletAddress).toMatch(/Invalid Stellar address/);
  });

  it("accepts a contact with no wallet at all", () => {
    expect(validateContactInput({ displayName: "No wallet yet", inviteDestination: "sam@example.com", inviteChannel: "email" })).toEqual({});
  });

  it("validates the invite destination for its channel", () => {
    expect(validateContactInput({ displayName: "x", inviteDestination: "nope", inviteChannel: "email" }).inviteDestination).toBeDefined();
    expect(validateContactInput({ displayName: "x", inviteDestination: "+44 7700 900123", inviteChannel: "phone" })).toEqual({});
  });

  it("canonicalises wallet, name and invite channel", () => {
    expect(
      normalizeContactInput({ displayName: "  Sam ", walletAddress: ` ${ADDR_A.toLowerCase()} `, inviteDestination: " sam@example.com " }),
    ).toEqual({ displayName: "Sam", walletAddress: ADDR_A, inviteDestination: "sam@example.com", inviteChannel: "email" });
  });
});

describe("unverified names never imply ownership", () => {
  it("reports a typed-in wallet as unverified", () => {
    expect(walletTrust(contact({ walletAddress: ADDR_A }))).toBe("unverified");
  });

  it("reports verified only when the claimed wallet is the current wallet", () => {
    expect(walletTrust(contact({ walletAddress: ADDR_A, walletVerified: true, claimedByWallet: ADDR_A }))).toBe("verified");
    // A verified flag left over from a different wallet proves nothing.
    expect(walletTrust(contact({ walletAddress: ADDR_B, walletVerified: true, claimedByWallet: ADDR_A }))).toBe("unverified");
  });

  it("reports no wallet when none is known", () => {
    expect(walletTrust(contact())).toBe("none");
  });

  it("creates trip members with a fresh id and only a known wallet", () => {
    expect(contactToMember(contact(), () => "m1")).toEqual({ id: "m1", name: "Sam" });
    expect(contactToMember(contact({ walletAddress: ADDR_A }), () => "m2")).toEqual({ id: "m2", name: "Sam", walletAddress: ADDR_A });
  });

  it("maps the hidden claim token out of contact rows", () => {
    const mapped = rowToContact({
      id: "c1", owner_wallet: OWNER, display_name: "Sam", wallet_address: null, wallet_verified: false,
      claimed_by_wallet: null, verified_at: null, invite_destination: null, invite_channel: null,
      claim_token_hash: "secret-hash", claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_at: "", updated_at: "",
    });
    expect(JSON.stringify(mapped)).not.toContain("secret-hash");
    expect(mapped.hasPendingClaim).toBe(true);
  });
});

describe("address changes notify active groups and keep history", () => {
  const trips: Trip[] = [
    { id: "active", name: "Flat", members: [{ id: "a", name: "Sam", walletAddress: ADDR_A.toLowerCase() }], expenseIds: [], createdAt: "", settled: false },
    { id: "settled", name: "2025", members: [{ id: "a", name: "Sam", walletAddress: ADDR_A }], expenseIds: ["e1"], createdAt: "", settled: true },
    { id: "other", name: "Other", members: [{ id: "b", name: "Bo", walletAddress: ADDR_B }], expenseIds: [], createdAt: "", settled: false },
  ];

  it("selects only unsettled trips that use the old wallet", () => {
    expect(affectedActiveTrips(trips, ADDR_A).map((t) => t.id)).toEqual(["active"]);
    expect(affectedActiveTrips(trips, undefined)).toEqual([]);
  });

  const change = (overrides: Partial<ContactWalletChange> = {}): ContactWalletChange => ({
    id: "w1", contactId: "c1", ownerWallet: OWNER, contactName: "Sam", oldWallet: ADDR_A, newWallet: ADDR_B,
    status: "pending_notice", affectedTripIds: ["active"], noticeUntil: "2026-05-02T00:00:00Z",
    verified: false, createdAt: "2026-05-01T00:00:00Z", ...overrides,
  });

  it("blocks applying a change while affected trips are within the notice period", () => {
    expect(canApplyWalletChange(change(), new Date("2026-05-01T12:00:00Z"))).toBe(false);
    expect(canApplyWalletChange(change(), new Date("2026-05-02T00:00:01Z"))).toBe(true);
  });

  it("allows an immediate change when no active trip uses the old wallet", () => {
    expect(canApplyWalletChange(change({ affectedTripIds: [] }), new Date("2026-05-01T00:00:00Z"))).toBe(true);
  });

  it("never re-applies a finished or cancelled change", () => {
    expect(canApplyWalletChange(change({ status: "applied" }), new Date("2030-01-01"))).toBe(false);
    expect(canApplyWalletChange(change({ status: "cancelled" }), new Date("2030-01-01"))).toBe(false);
  });

  it("shows a trip only the pending changes that affect it", () => {
    const list = [change(), change({ id: "w2", affectedTripIds: ["other"] }), change({ id: "w3", status: "applied" })];
    expect(walletChangesForTrip(list, "active").map((c) => c.id)).toEqual(["w1"]);
  });

  it("translates database verdicts into readable messages", () => {
    expect(contactErrorMessage("ERROR: CONTACT_NOTICE_PERIOD_ACTIVE: until x")).toMatch(/still being notified/);
    expect(contactErrorMessage('duplicate key value violates unique constraint "contacts_owner_wallet_unique_idx"'))
      .toMatch(/already have a contact/);
  });
});

describe("database guarantees (static)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const sql = fs.readFileSync(path.join(ROOT, "migrations/0009_contacts_member_profiles.sql"), "utf8");
  const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

  it("enforces wallet uniqueness per owner, not name uniqueness", () => {
    expect(sql).toMatch(/contacts_owner_wallet_unique_idx\s+ON public\.contacts \(owner_wallet, wallet_address\)/);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*display_name/);
  });

  it("canonicalises wallets in the database and stores only the claim token hash", () => {
    expect(sql).toContain("NEW.wallet_address := NULLIF(upper(btrim(COALESCE(NEW.wallet_address, ''))), '');");
    expect(sql).not.toMatch(/claim_token\s+TEXT/);
  });

  it("prevents direct writes to verification fields and in-place wallet swaps", () => {
    expect(sql).toContain("NEW.wallet_verified := FALSE;");
    expect(sql).toContain("NEW.wallet_verified := OLD.wallet_verified;");
    expect(sql).toContain("CONTACT_WALLET_CHANGE_REQUIRES_NOTICE");
  });

  it("verifies only the wallet signed into the session", () => {
    expect(sql).toMatch(/v_claimant TEXT := public\.current_wallet\(\);/);
    expect(sql).toContain("CONTACT_CLAIM_SELF");
  });

  it("only selects unsettled trips as affected, and never updates trips or expenses", () => {
    expect(sql).toMatch(/t\.settled = FALSE/);
    expect(sql).not.toMatch(/UPDATE public\.(trips|expenses)/);
  });

  it("is mirrored and recorded in the setup path", () => {
    expect(setup).toContain("CREATE OR REPLACE FUNCTION public.claim_contact_profile(");
    expect(setup).toContain("('0009', '0009_contacts_member_profiles', 'contacts_member_profiles_v1')");
  });
});
