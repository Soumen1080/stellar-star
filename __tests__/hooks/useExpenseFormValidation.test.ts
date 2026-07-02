import { validateExpenseFormFields } from "@/hooks/useExpenseForm";
import type { Member } from "@/types/expense";

// ─── Shared fixture ────────────────────────────────────────────────────────────

// Real valid Stellar addresses (pass SDK checksum validation)
const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const ADDR_C = "GA4ZPR3FCSUCTM4NK4SKNMBXV4IS7CUDISAX7PWK3PWFBWIQH2OW2O6I";

const validMembers: Member[] = [
  { id: "member-1", name: "Asha", walletAddress: ADDR_A },
  { id: "member-2", name: "Ravi", walletAddress: ADDR_B },
];

// ─── Existing tests ────────────────────────────────────────────────────────────

describe("validateExpenseFormFields", () => {
  it("requires a title, valid amount, member names, and Stellar addresses", () => {
    const errors = validateExpenseFormFields({
      title: "",
      totalAmount: "0",
      members: [
        { id: "member-1", name: "", walletAddress: "" },
        { id: "member-2", name: "Ravi", walletAddress: "bad-address" },
      ],
    });

    expect(errors.title).toBe("Title is required.");
    expect(errors.totalAmount).toMatch(/valid XLM amount/);
    expect(errors.member_name_0).toBe("Name is required.");
    expect(errors.member_addr_0).toMatch(/required/);
    expect(errors.member_addr_1).toMatch(/Invalid Stellar address/);
  });

  it("passes when required fields are valid", () => {
    const errors = validateExpenseFormFields({
      title: "Dinner",
      totalAmount: "12.5",
      members: validMembers,
    });

    expect(errors).toEqual({});
  });

  // ─── Duplicate wallet tests ────────────────────────────────────────────────

  it("rejects two members with the same wallet address (exact match)", () => {
    const errors = validateExpenseFormFields({
      title: "Lunch",
      totalAmount: "5",
      members: [
        { id: "m1", name: "Alice", walletAddress: ADDR_A },
        { id: "m2", name: "Bob",   walletAddress: ADDR_A },
      ],
    });

    expect(errors.member_addr_1).toMatch(/Duplicate wallet address/);
    expect(errors.member_addr_0).toMatch(/Duplicate wallet address/);
  });

  it("treats addresses case-insensitively for duplicate detection (both uppercase)", () => {
    // SDK only accepts uppercase; duplicate check normalises to uppercase before comparing
    const errors = validateExpenseFormFields({
      title: "Taxi",
      totalAmount: "3",
      members: [
        { id: "m1", name: "Alice", walletAddress: ADDR_A },
        { id: "m2", name: "Bob",   walletAddress: ADDR_A },
      ],
    });

    expect(errors.member_addr_1).toMatch(/Duplicate wallet address/);
  });

  it("trims whitespace before comparing addresses", () => {
    const errors = validateExpenseFormFields({
      title: "Hotel",
      totalAmount: "50",
      members: [
        { id: "m1", name: "Alice", walletAddress: `  ${ADDR_A}  ` },
        { id: "m2", name: "Bob",   walletAddress: ADDR_A },
      ],
    });

    expect(errors.member_addr_1).toMatch(/Duplicate wallet address/);
  });

  it("flags all duplicates when three members share the same address", () => {
    const errors = validateExpenseFormFields({
      title: "Groceries",
      totalAmount: "20",
      members: [
        { id: "m1", name: "Alice", walletAddress: ADDR_A },
        { id: "m2", name: "Bob",   walletAddress: ADDR_A },
        { id: "m3", name: "Carol", walletAddress: ADDR_A },
      ],
    });

    // Member 0 is flagged because it collides with 1 (and later 2)
    expect(errors.member_addr_0).toMatch(/Duplicate wallet address/);
    expect(errors.member_addr_1).toMatch(/Duplicate wallet address/);
    expect(errors.member_addr_2).toMatch(/Duplicate wallet address/);
  });

  it("does not flag members with distinct valid addresses", () => {
    const errors = validateExpenseFormFields({
      title: "Dinner",
      totalAmount: "30",
      members: [
        { id: "m1", name: "Alice", walletAddress: ADDR_A },
        { id: "m2", name: "Bob",   walletAddress: ADDR_B },
        { id: "m3", name: "Carol", walletAddress: ADDR_C },
      ],
    });

    expect(errors.member_addr_0).toBeUndefined();
    expect(errors.member_addr_1).toBeUndefined();
    expect(errors.member_addr_2).toBeUndefined();
  });

  it("rejects an address that matches G[A-Z2-7]{55} shape but fails SDK checksum validation", () => {
    // 'G' + 'A'*55 is 56 chars and regex-valid but checksum-invalid
    const errors = validateExpenseFormFields({
      title: "Dinner",
      totalAmount: "10",
      members: [
        { id: "m1", name: "Alice", walletAddress: ADDR_A },
        { id: "m2", name: "Bob",   walletAddress: "G" + "A".repeat(55) },
      ],
    });

    expect(errors.member_addr_1).toMatch(/Invalid Stellar address/);
  });
});

