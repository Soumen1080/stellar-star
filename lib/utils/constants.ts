export type StellarNetwork = "TESTNET" | "PUBLIC";

export const STELLAR_NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK as StellarNetwork) ?? "TESTNET";

/**
 * Canonical, network-correct endpoints.
 *
 * Every endpoint Stellar-star talks to is pinned to a network. The failure mode
 * we are defending against is `STELLAR_NETWORK=PUBLIC` while one of the
 * infrastructure URLs still points at testnet — the app would then build
 * mainnet-passphrase transactions but broadcast them to testnet Horizon, or
 * show mainnet payments on a testnet explorer. To make that structurally
 * impossible we *derive* each URL from the network unless it is explicitly
 * overridden, and then validate any override against the network it targets
 * (see `getNetworkConfigErrors`).
 */
export const CANONICAL_ENDPOINTS: Record<StellarNetwork, {
  horizon: string;
  sorobanRpc: string;
  explorer: string;
}> = {
  TESTNET: {
    horizon:   "https://horizon-testnet.stellar.org",
    sorobanRpc: "https://soroban-testnet.stellar.org",
    explorer:   "https://stellar.expert/explorer/testnet",
  },
  PUBLIC: {
    horizon:   "https://horizon.stellar.org",
    sorobanRpc: "https://rpc.stellar.org",
    explorer:   "https://stellar.expert/explorer/public",
  },
};

const override = (value: string | undefined, fallback: string): string =>
  value && value.trim() !== "" ? value.trim() : fallback;

/** Resolves to the canonical endpoint for the configured network by default. */
export const HORIZON_URL = override(
  process.env.NEXT_PUBLIC_HORIZON_URL,
  CANONICAL_ENDPOINTS[STELLAR_NETWORK].horizon
);

export const STELLAR_EXPLORER = override(
  process.env.NEXT_PUBLIC_STELLAR_EXPLORER,
  CANONICAL_ENDPOINTS[STELLAR_NETWORK].explorer
);

export const SOROBAN_RPC_URL = override(
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  CANONICAL_ENDPOINTS[STELLAR_NETWORK].sorobanRpc
);

export const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === "PUBLIC"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

/** Human label for the network this deployment is configured for. */
export const NETWORK_LABEL: string =
  STELLAR_NETWORK === "PUBLIC" ? "Mainnet" : "Testnet";

/** Presentation string used wherever we name the app's network to the user. */
export const NETWORK_DISPLAY_NAME = `Stellar ${NETWORK_LABEL}`;

/**
 * Maps a wallet-reported network string to a human label.
 * Used so no component ever hardcodes "Testnet" / "Mainnet".
 */
export function networkLabel(network: string | null | undefined): string {
  if (network === "PUBLIC") return "Mainnet";
  if (network === "TESTNET") return "Testnet";
  return "an unknown network";
}

// ── Memo / fees ───────────────────────────────────────────────────────────────

export const MEMO_PREFIX    = "StellarStar";
/**
 * Protocol-minimum base fee per operation, in stroops.
 *
 * This is the *floor*, not the strategy. Live transactions derive their fee
 * from observed network conditions via `getSuggestedBaseFee` (lib/stellar/fees)
 * so they survive surge pricing. Kept as a safe fallback only.
 */
export const TX_BASE_FEE    = 100;
export const MEMO_MAX_BYTES = 28;

// ── Local storage keys ─────────────────────────────────────────────────────────

export const LS_PUBLIC_KEY         = "StellarStar:publicKey";
export const LS_EXPENSES           = "StellarStar:expenses";
export const LS_TRIPS              = "StellarStar:trips";
export const LS_USER               = "StellarStar:user";
export const LS_PENDING_ON_CHAIN   = "StellarStar:pendingOnChain";

// ── App metadata ───────────────────────────────────────────────────────────────

export const APP_NAME    = process.env.NEXT_PUBLIC_APP_NAME    ?? "Stellar-star";
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0";

export const CONTRACT_ID =
  process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";

/**
 * The attestation oracle's *public* key (G...), used client-side only to check
 * that a returned attestation was signed by the key this deployment expects.
 *
 * The matching secret lives in the server-only `SETTLEMENT_ORACLE_SECRET` and
 * must never be given a `NEXT_PUBLIC_` name — `lib/settlement/oracleKey.ts`
 * refuses to sign if it finds one, since such a key is already published.
 */
export const ORACLE_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEY ?? "";

/**
 * Contract address of the single asset this deployment settles in.
 *
 * Single-asset by design for now: the pool holds one token and the contract
 * compares the attested asset against this one for equality. Multi-asset pool
 * routing is issue #43.
 */
export const SETTLEMENT_ASSET_ID =
  process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_ID ??
  process.env.NEXT_PUBLIC_POOL_TOKEN_ID ??
  "";

// ── Network configuration validation ───────────────────────────────────────────
//
// "Internally consistent by construction, or the app refuses to start." The
// derivation above makes the common case consistent without any effort. This
// layer catches the dangerous case: an *explicit* override that points at the
// wrong network, which the derivation cannot fix because the operator asked for
// it. We surface every problem as a specific, actionable message.

export class NetworkConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("\n"));
    this.name = "NetworkConfigError";
    this.errors = errors;
  }
}

function classifyHorizon(url: string): StellarNetwork | null {
  if (url.includes("horizon-testnet.stellar.org")) return "TESTNET";
  if (url.includes("horizon.stellar.org")) return "PUBLIC";
  return null;
}

function classifySoroban(url: string): StellarNetwork | null {
  if (url.includes("soroban-testnet.stellar.org")) return "TESTNET";
  if (
    url.includes("rpc.stellar.org") ||
    url.includes("soroban.stellar.org") ||
    url.includes("mainnet.soroban-rpc.com")
  ) {
    return "PUBLIC";
  }
  return null;
}

function classifyExplorer(url: string): StellarNetwork | null {
  if (url.includes("/explorer/testnet")) return "TESTNET";
  if (url.includes("/explorer/public")) return "PUBLIC";
  return null;
}

/**
 * Returns a list of actionable error messages describing every way the resolved
 * network configuration is inconsistent. An empty list means the configuration
 * is safe to run.
 *
 * Detection rules:
 *  - An endpoint whose host clearly belongs to the *other* network than
 *    `STELLAR_NETWORK` is a hard misconfiguration (the app would sign against
 *    the wrong infrastructure).
 *  - Two or more endpoints that resolve to *different* networks from each other
 *    is internally contradictory regardless of `STELLAR_NETWORK`.
 * Endpoints on hosts we do not recognise are left alone — operators may run
 * private or third-party infrastructure we cannot classify.
 */
export function getNetworkConfigErrors(): string[] {
  const expected = STELLAR_NETWORK;
  const checks: Array<[string, string, StellarNetwork | null]> = [
    ["HORIZON_URL", HORIZON_URL, classifyHorizon(HORIZON_URL)],
    ["SOROBAN_RPC_URL", SOROBAN_RPC_URL, classifySoroban(SOROBAN_RPC_URL)],
    ["STELLAR_EXPLORER", STELLAR_EXPLORER, classifyExplorer(STELLAR_EXPLORER)],
  ];

  const errors: string[] = [];

  for (const [name, url, classified] of checks) {
    if (classified && classified !== expected) {
      errors.push(
        `STELLAR_NETWORK is "${expected}" but ${name}="${url}" targets the ${classified} network. ` +
          `Set ${name} to the ${expected} endpoint, or remove it to use the default for ${expected}.`
      );
    }
  }

  const classifiedNets = checks.map((c) => c[2]).filter(Boolean) as StellarNetwork[];
  const distinct = new Set(classifiedNets);
  if (distinct.size > 1) {
    errors.push(
      `Network endpoints are inconsistent: they target multiple Stellar networks (${[...distinct].join(
        ", "
      )}). HORIZON_URL, SOROBAN_RPC_URL and STELLAR_EXPLORER must all point at the same network.`
    );
  }

  return errors;
}

/** Throws a `NetworkConfigError` when the resolved config is unsafe to run. */
export function assertValidNetworkConfig(): void {
  const errors = getNetworkConfigErrors();
  if (errors.length > 0) {
    throw new NetworkConfigError(errors);
  }
}
