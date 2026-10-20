import {
  generateScopedToken,
  verifyScopedToken,
  listTokensForWallet,
  revokeToken,
  clearTokenStore,
} from "@/lib/api/tokens";

describe("Scoped Developer API Tokens", () => {
  const testWallet = "G_TEST_DEVELOPER_WALLET_123456789012345678901234567890";

  beforeEach(() => {
    clearTokenStore();
  });

  it("mints a valid scoped token with cryptographic signature", () => {
    const { token, record } = generateScopedToken({
      walletAddress: testWallet,
      name: "QuickBooks Integration",
      scopes: ["trips:read", "expenses:read"],
    });

    expect(token).toMatch(/^stk_live_/);
    expect(record.name).toBe("QuickBooks Integration");
    expect(record.walletAddress).toBe(testWallet);
    expect(record.scopes).toEqual(["trips:read", "expenses:read"]);

    const verification = verifyScopedToken(token);
    expect(verification.valid).toBe(true);
    expect(verification.payload?.tokenId).toBe(record.tokenId);
    expect(verification.payload?.walletAddress).toBe(testWallet);
    expect(verification.payload?.scopes).toEqual(["trips:read", "expenses:read"]);
  });

  it("strictly forbids raw Supabase service role keys as API credentials", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.raw_service_role_key";

    const res = verifyScopedToken(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/raw supabase service keys are forbidden/i);
  });

  it("rejects tokens with forged or tampered signatures", () => {
    const { token } = generateScopedToken({
      walletAddress: testWallet,
      name: "Accounting Sync",
      scopes: ["trips:read"],
    });

    // Tamper with the signature portion
    const tampered = token.slice(0, -4) + "beef";
    const res = verifyScopedToken(tampered);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/invalid token signature/i);
  });

  it("rejects revoked tokens", () => {
    const { token, record } = generateScopedToken({
      walletAddress: testWallet,
      name: "Revocable Token",
      scopes: ["trips:read"],
    });

    expect(verifyScopedToken(token).valid).toBe(true);

    const revoked = revokeToken(record.tokenId, testWallet);
    expect(revoked).toBe(true);

    const postRevocation = verifyScopedToken(token);
    expect(postRevocation.valid).toBe(false);
    expect(postRevocation.error).toMatch(/revoked/i);
  });

  it("lists all tokens generated for a wallet", () => {
    generateScopedToken({
      walletAddress: testWallet,
      name: "Token 1",
      scopes: ["trips:read"],
    });
    generateScopedToken({
      walletAddress: testWallet,
      name: "Token 2",
      scopes: ["expenses:read"],
    });

    const tokens = listTokensForWallet(testWallet);
    expect(tokens.length).toBe(2);
    expect(tokens.map((t) => t.name)).toContain("Token 1");
    expect(tokens.map((t) => t.name)).toContain("Token 2");
  });
});
