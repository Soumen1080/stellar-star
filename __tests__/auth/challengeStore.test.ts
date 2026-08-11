import { consumeChallenge, issueChallenge } from "@/lib/auth/challengeStore";

describe("wallet challenge registry", () => {
  it("allows an issued challenge to be consumed once", () => {
    const address = "GTESTADDRESS";
    const nonce = `nonce-${Date.now()}-one`;
    const expiration = Date.now() + 60_000;

    issueChallenge(address, nonce, expiration);

    expect(consumeChallenge(address, nonce, expiration)).toBe(true);
    expect(consumeChallenge(address, nonce, expiration)).toBe(false);
  });

  it("does not consume a challenge when its address or expiration differs", () => {
    const address = "GTESTADDRESS";
    const nonce = `nonce-${Date.now()}-two`;
    const expiration = Date.now() + 60_000;

    issueChallenge(address, nonce, expiration);

    expect(consumeChallenge("GOTHERADDRESS", nonce, expiration)).toBe(false);
    expect(consumeChallenge(address, nonce, expiration + 1)).toBe(false);
    expect(consumeChallenge(address, nonce, expiration)).toBe(true);
  });
});
