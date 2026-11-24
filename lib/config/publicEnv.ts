/** Explicit allowlist of values that are safe to inline into browser bundles. */
const publicEnv = {
  stellarNetwork: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  stellarAssets: process.env.NEXT_PUBLIC_STELLAR_ASSETS,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  contractId: process.env.NEXT_PUBLIC_CONTRACT_ID,
  settlementContractId: process.env.NEXT_PUBLIC_SETTLEMENT_CONTRACT_ID,
  poolContractId: process.env.NEXT_PUBLIC_POOL_CONTRACT_ID,
  settlementAssetId: process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_ID,
  poolTokenId: process.env.NEXT_PUBLIC_POOL_TOKEN_ID,
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL,
  sorobanRpcUrl: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  stellarExplorer: process.env.NEXT_PUBLIC_STELLAR_EXPLORER,
  usdcIssuer: process.env.NEXT_PUBLIC_USDC_ISSUER,
  appName: process.env.NEXT_PUBLIC_APP_NAME,
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  receiptOcrEnabled: process.env.NEXT_PUBLIC_RECEIPT_OCR_ENABLED,
  e2eTestMode: process.env.NEXT_PUBLIC_E2E_TEST_MODE,
  pathPriceImpactThresholdBps: process.env.NEXT_PUBLIC_PATH_PRICE_IMPACT_THRESHOLD_BPS,
  settlementOraclePublicKeys: process.env.NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEYS,
  settlementOraclePublicKey: process.env.NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEY,
  settlementOracleThreshold: process.env.NEXT_PUBLIC_SETTLEMENT_ORACLE_THRESHOLD,
} as const;

export type PublicEnv = typeof publicEnv;
export { publicEnv };
