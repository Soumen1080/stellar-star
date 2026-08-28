import { consumeChallenge, issueChallenge } from "@/lib/auth/challengeStore";

describe("wallet challenge registry", () => {
  it("allows an issued challenge to be consumed once", async () => {
    const address = "GTESTADDRESS";
    const nonce = `nonce-${Date.now()}-one`;
    const expiration = Date.now() + 60_000;

    await issueChallenge(address, nonce, expiration);

    expect(await consumeChallenge(address, nonce, expiration)).toBe(true);
    expect(await consumeChallenge(address, nonce, expiration)).toBe(false);
  });

  it("does not consume a challenge when its address or expiration differs", async () => {
    const address = "GTESTADDRESS";
    const nonce = `nonce-${Date.now()}-two`;
    const expiration = Date.now() + 60_000;

    await issueChallenge(address, nonce, expiration);

    expect(await consumeChallenge("GOTHERADDRESS", nonce, expiration)).toBe(false);
    expect(await consumeChallenge(address, nonce, expiration + 1)).toBe(false);
    expect(await consumeChallenge(address, nonce, expiration)).toBe(true);
  });
});
