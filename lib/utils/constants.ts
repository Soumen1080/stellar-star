export const STELLAR_NETWORK =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK as "TESTNET" | "PUBLIC") ?? "TESTNET";

export const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

export const STELLAR_EXPLORER =
  process.env.NEXT_PUBLIC_STELLAR_EXPLORER ??
  "https://stellar.expert/explorer/testnet";

export const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === "PUBLIC"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

export const MEMO_PREFIX    = "StellarStar";
export const TX_BASE_FEE    = 100;
export const MEMO_MAX_BYTES = 28;

export const LS_PUBLIC_KEY         = "StellarStar:publicKey";
export const LS_EXPENSES           = "StellarStar:expenses";
export const LS_TRIPS              = "StellarStar:trips";
export const LS_USER               = "StellarStar:user";
export const LS_PENDING_ON_CHAIN   = "StellarStar:pendingOnChain";

export const APP_NAME    = process.env.NEXT_PUBLIC_APP_NAME    ?? "Stellar-star";
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0";

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

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
