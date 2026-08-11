/**
 * Tracks issued wallet challenges for the lifetime of a server instance.
 *
 * The signed HMAC protects a challenge from forgery; this store additionally
 * makes a successfully verified challenge single-use on a warm instance. The
 * short expiry and bounded size keep the store small. Deployments spanning
 * several server instances should back this with an atomic shared store for
 * cross-instance replay protection.
 */
type Challenge = {
  address: string;
  expiration: number;
};

const MAX_PENDING_CHALLENGES = 10_000;

declare global {
  // Preserve issued challenges through Next.js development hot reloads.
  // eslint-disable-next-line no-var
  var stellarStarChallenges: Map<string, Challenge> | undefined;
}

const challenges = globalThis.stellarStarChallenges ?? new Map<string, Challenge>();
globalThis.stellarStarChallenges = challenges;

function removeExpiredChallenges(now = Date.now()): void {
  for (const [nonce, challenge] of challenges) {
    if (challenge.expiration <= now) challenges.delete(nonce);
  }
}

export function issueChallenge(address: string, nonce: string, expiration: number): void {
  removeExpiredChallenges();

  // Map iteration is insertion ordered, so this removes the oldest entries
  // before adding a new one if a process receives excessive challenge traffic.
  while (challenges.size >= MAX_PENDING_CHALLENGES) {
    const oldestNonce = challenges.keys().next().value;
    if (!oldestNonce) break;
    challenges.delete(oldestNonce);
  }

  challenges.set(nonce, { address, expiration });
}

/** Atomically consumes an issued challenge, preventing a second successful use. */
export function consumeChallenge(address: string, nonce: string, expiration: number): boolean {
  removeExpiredChallenges();

  const challenge = challenges.get(nonce);
  if (!challenge || challenge.address !== address || challenge.expiration !== expiration) {
    return false;
  }

  challenges.delete(nonce);
  return true;
}
