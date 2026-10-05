import {
  normalizeWalletAddress,
  canonicalAddress,
  isValidMemberAddress,
  areWalletAddressesEqual,
  normalizeMember,
  normalizeMembers,
  isMemberInTrip,
  hasMemberWithAddress,
  findMemberByWallet,
  deduplicateMembers,
  findDuplicateMemberAddresses,
} from "@/lib/trip/members";
import type { Member } from "@/types/expense";

const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

describe("lib/trip/members", () => {
  describe("normalizeWalletAddress and canonicalAddress", () => {
    it("trims whitespace and uppercases lowercase addresses", () => {
      expect(normalizeWalletAddress(`  ${ADDR_A.toLowerCase()}  `)).toBe(ADDR_A);
      expect(canonicalAddress(`  ${ADDR_B.toLowerCase()}  `)).toBe(ADDR_B);
    });

    it("returns empty string for null, undefined, or empty values", () => {
      expect(normalizeWalletAddress(null)).toBe("");
      expect(normalizeWalletAddress(undefined)).toBe("");
      expect(normalizeWalletAddress("")).toBe("");
      expect(normalizeWalletAddress("   ")).toBe("");
    });
  });

  describe("isValidMemberAddress", () => {
    it("validates canonical and lowercased addresses", () => {
      expect(isValidMemberAddress(ADDR_A)).toBe(true);
      expect(isValidMemberAddress(ADDR_A.toLowerCase())).toBe(true);
      expect(isValidMemberAddress(` ${ADDR_A.toLowerCase()} `)).toBe(true);
    });

    it("rejects malformed or invalid addresses", () => {
      expect(isValidMemberAddress("G123")).toBe(false);
      expect(isValidMemberAddress("")).toBe(false);
      expect(isValidMemberAddress(null)).toBe(false);
    });
  });

  describe("areWalletAddressesEqual", () => {
    it("returns true for matching addresses regardless of case or whitespace", () => {
      expect(areWalletAddressesEqual(ADDR_A, ADDR_A.toLowerCase())).toBe(true);
      expect(areWalletAddressesEqual(` ${ADDR_A} `, ADDR_A.toLowerCase())).toBe(true);
    });

    it("returns false for different addresses or empty inputs", () => {
      expect(areWalletAddressesEqual(ADDR_A, ADDR_B)).toBe(false);
      expect(areWalletAddressesEqual("", ADDR_A)).toBe(false);
      expect(areWalletAddressesEqual(null, undefined)).toBe(false);
    });
  });

  describe("normalizeMember and normalizeMembers", () => {
    it("normalizes name and walletAddress at the boundary", () => {
      const raw: Member = {
        id: "1",
        name: "  Alice  ",
        walletAddress: `  ${ADDR_A.toLowerCase()}  `,
      };
      const normalized = normalizeMember(raw);
      expect(normalized.name).toBe("Alice");
      expect(normalized.walletAddress).toBe(ADDR_A);
    });

    it("normalizes an array of members", () => {
      const list: Member[] = [
        { id: "1", name: " Alice ", walletAddress: ADDR_A.toLowerCase() },
        { id: "2", name: " Bob ", walletAddress: ADDR_B.toLowerCase() },
      ];
      const result = normalizeMembers(list);
      expect(result[0].walletAddress).toBe(ADDR_A);
      expect(result[1].walletAddress).toBe(ADDR_B);
    });
  });

  describe("isMemberInTrip / hasMemberWithAddress / findMemberByWallet", () => {
    const members: Member[] = [
      { id: "1", name: "Alice", walletAddress: ADDR_A },
      { id: "2", name: "Bob", walletAddress: ADDR_B },
    ];

    it("performs case-insensitive and trimmed lookup for invite checks", () => {
      expect(isMemberInTrip(members, ADDR_A.toLowerCase())).toBe(true);
      expect(hasMemberWithAddress(members, ` ${ADDR_B.toLowerCase()} `)).toBe(true);
      expect(isMemberInTrip(members, "GNOTAMEMBER111111111111111111111111111111111111111111111111")).toBe(false);
    });

    it("finds member record by wallet regardless of casing", () => {
      const found = findMemberByWallet(members, ADDR_A.toLowerCase());
      expect(found?.id).toBe("1");
      expect(findMemberByWallet(members, "GUNKNOWN")).toBeUndefined();
    });
  });

  describe("deduplicateMembers", () => {
    it("deduplicates members with identical addresses differing only by casing", () => {
      const members: Member[] = [
        { id: "1", name: "Alice", walletAddress: ADDR_A },
        { id: "2", name: "Alice Alt", walletAddress: ADDR_A.toLowerCase() },
        { id: "3", name: "Bob", walletAddress: ADDR_B },
      ];
      const deduped = deduplicateMembers(members);
      expect(deduped).toHaveLength(2);
      expect(deduped[0].id).toBe("1");
      expect(deduped[1].id).toBe("3");
    });
  });

  describe("findDuplicateMemberAddresses", () => {
    it("flags duplicate member addresses across differing cases and whitespace", () => {
      const errors = findDuplicateMemberAddresses([
        ADDR_A,
        ` ${ADDR_A.toLowerCase()} `,
      ]);
      expect(errors[0]).toMatch(/Duplicate wallet address/);
      expect(errors[1]).toMatch(/Duplicate wallet address/);
    });
  });
});
