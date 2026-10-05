import { buildQRPaymentURI } from "@/lib/qr/generator";

describe("buildQRPaymentURI", () => {
  const destination = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
  const amount = "10.0000000";

  it("constructs a correct web+stellar:pay URI without memo", () => {
    const uri = buildQRPaymentURI({ destination, amount });
    const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
    expect(url.searchParams.get("destination")).toBe(destination);
    expect(url.searchParams.get("amount")).toBe(amount);
    expect(url.searchParams.get("memo")).toBeNull();
  });

  it("throws on invalid destination address", () => {
    expect(() =>
      buildQRPaymentURI({ destination: "INVALID_ADDR", amount }),
    ).toThrow(/Invalid destination Stellar address/);
  });

  it("supports non-native asset codes and issuers", () => {
    const issuer = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
    const uri = buildQRPaymentURI({
      destination,
      amount,
      assetCode: "USDC",
      assetIssuer: issuer,
    });
    const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
    expect(url.searchParams.get("asset_code")).toBe("USDC");
    expect(url.searchParams.get("asset_issuer")).toBe(issuer);
  });

  it("includes short memo untouched", () => {
    const memo = "Short Memo";
    const uri = buildQRPaymentURI({ destination, amount, memo });
    const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
    expect(url.searchParams.get("memo")).toBe(memo);
    expect(url.searchParams.get("memo_type")).toBe("MEMO_TEXT");
  });

  it("truncates long ASCII memo to exactly 28 bytes", () => {
    const memo = "This is a very long memo exceeding 28 characters";
    const uri = buildQRPaymentURI({ destination, amount, memo });
    const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
    const resultMemo = url.searchParams.get("memo") || "";
    
    expect(resultMemo.length).toBe(28);
    expect(new TextEncoder().encode(resultMemo).length).toBe(28);
    expect(resultMemo).toBe("This is a very long memo exc");
  });

  it("truncates multi-byte string (emojis) without producing malformed UTF-8", () => {
    const memo = "12345678901234567890123456🍕";
    const uri = buildQRPaymentURI({ destination, amount, memo });
    const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
    const resultMemo = url.searchParams.get("memo") || "";

    expect(new TextEncoder().encode(resultMemo).length).toBe(26);
    expect(resultMemo).toBe("12345678901234567890123456");
    expect(resultMemo).not.toContain("\uFFFD");
  });

  it("truncates safely if the cut happens exactly at emoji boundary", () => {
    const memo = "123456789012345678901234🍕";
    const uri = buildQRPaymentURI({ destination, amount, memo });
    const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
    const resultMemo = url.searchParams.get("memo") || "";

    expect(new TextEncoder().encode(resultMemo).length).toBe(28);
    expect(resultMemo).toBe("123456789012345678901234🍕");
  });

  describe("destination validation", () => {
    it("throws an error when destination is not a valid Stellar Ed25519 public key", () => {
      expect(() => {
        buildQRPaymentURI({ destination: "invalid-address", amount });
      }).toThrow(/Invalid destination address/);
    });

    it("throws an error when destination is a secret key or malformed", () => {
      expect(() => {
        buildQRPaymentURI({
          destination: "SBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDR",
          amount,
        });
      }).toThrow(/Invalid destination address/);
    });
  });

  describe("non-native assets", () => {
    const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

    it("includes asset_code and asset_issuer when both are provided", () => {
      const uri = buildQRPaymentURI({
        destination,
        amount,
        assetCode: "USDC",
        assetIssuer: issuer,
      });
      const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
      expect(url.searchParams.get("destination")).toBe(destination);
      expect(url.searchParams.get("amount")).toBe(amount);
      expect(url.searchParams.get("asset_code")).toBe("USDC");
      expect(url.searchParams.get("asset_issuer")).toBe(issuer);
    });

    it("includes asset_code without asset_issuer when only assetCode is provided", () => {
      const uri = buildQRPaymentURI({
        destination,
        amount,
        assetCode: "USDC",
      });
      const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
      expect(url.searchParams.get("asset_code")).toBe("USDC");
      expect(url.searchParams.get("asset_issuer")).toBeNull();
    });

    it("throws an error when assetIssuer is invalid", () => {
      expect(() => {
        buildQRPaymentURI({
          destination,
          amount,
          assetCode: "USDC",
          assetIssuer: "not-a-valid-issuer",
        });
      }).toThrow(/Invalid asset issuer address/);
    });

    it("omits asset_code and asset_issuer when neither is provided", () => {
      const uri = buildQRPaymentURI({ destination, amount });
      const url = new URL(uri.replace("web+stellar:pay", "https://stellar"));
      expect(url.searchParams.get("asset_code")).toBeNull();
      expect(url.searchParams.get("asset_issuer")).toBeNull();
    });
  });
});
