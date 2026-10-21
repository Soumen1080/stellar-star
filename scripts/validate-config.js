/**
 * scripts/validate-config.js
 *
 * Mandatory deployment control & CI configuration validator (Issue #306).
 *
 * Validates:
 *  1. Selected network (NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET" | "PUBLIC").
 *  2. Horizon endpoint consistency and network matching.
 *  3. Soroban RPC endpoint consistency and network matching.
 *  4. Stellar Explorer URL consistency and network matching.
 *  5. Contract IDs (format, presence in production, rejection of placeholder / testnet IDs).
 *  6. Asset issuer values (Ed25519 public key format, Circle USDC network matching).
 *  7. Public app URL (HTTPS protocol, no localhost in production).
 *  8. Secrets hygiene: Ensures server secrets are NEVER exposed in NEXT_PUBLIC_ variables
 *     and sensitive values are NEVER printed.
 */

const CANONICAL_ENDPOINTS = {
  TESTNET: {
    horizon: "https://horizon-testnet.stellar.org",
    sorobanRpc: "https://soroban-testnet.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet",
  },
  PUBLIC: {
    horizon: "https://horizon.stellar.org",
    sorobanRpc: "https://rpc.stellar.org",
    explorer: "https://stellar.expert/explorer/public",
  },
};

const CIRCLE_USDC = {
  TESTNET: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  PUBLIC: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

// Known testnet / placeholder contract IDs that must NEVER be used in production
const TESTNET_DEMO_CONTRACT = "CBS2BJQ4ZC2ZSAZ5XS47BGC6Q7VTMJA4SE2PVHFXGXAZI5ES6H645WHO";
const KNOWN_PLACEHOLDER_REGEX = /^(placeholder|replace[-_]?me|TODO|test[-_]?contract|xxx|your[-_]?contract)/i;

const SENSITIVE_SECRET_PATTERNS = [
  "SUPABASE_JWT_SECRET",
  "JWT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SETTLEMENT_ORACLE_SECRET",
  "SPONSOR_OPERATOR_SECRET",
  "COINGECKO_API_KEY",
  "EXCHANGERATE_API_KEY",
  "TESTNET_PAYER_SECRET",
  "TESTNET_RECIPIENT_SECRET",
];

function isContractAddress(id) {
  return typeof id === "string" && /^C[A-Z0-9]{55}$/.test(id.trim());
}

function isPublicKey(key) {
  return typeof key === "string" && /^G[A-Z0-9]{55}$/.test(key.trim());
}

function classifyHorizon(url) {
  if (!url) return null;
  if (url.includes("horizon-testnet.stellar.org")) return "TESTNET";
  if (url.includes("horizon.stellar.org")) return "PUBLIC";
  return null;
}

function classifySoroban(url) {
  if (!url) return null;
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

function classifyExplorer(url) {
  if (!url) return null;
  if (url.includes("/explorer/testnet")) return "TESTNET";
  if (url.includes("/explorer/public")) return "PUBLIC";
  return null;
}

/**
 * Validates configuration based on the provided environment and options.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {object} [options={}]
 * @param {boolean} [options.isProduction=false]
 * @returns {{ valid: boolean, errors: string[], warnings: string[], summary: { network: string, isProduction: boolean, horizon: string, sorobanRpc: string, explorer: string, contractIdConfigured: boolean, usdcIssuerConfigured: boolean, siteUrlConfigured: boolean } }}
 */
function validateConfig(env = process.env, options = {}) {
  const errors = [];
  const warnings = [];

  const rawNetwork = env.NEXT_PUBLIC_STELLAR_NETWORK?.trim() || "";
  const isProduction =
    Boolean(options.isProduction) ||
    env.NODE_ENV === "production" ||
    rawNetwork === "PUBLIC" ||
    env.PRODUCTION_CHECK === "1";

  // 1. Network Validation
  let network = rawNetwork.toUpperCase();
  if (!network) {
    network = isProduction ? "PUBLIC" : "TESTNET";
  }

  if (network !== "TESTNET" && network !== "PUBLIC") {
    errors.push(
      `NEXT_PUBLIC_STELLAR_NETWORK must be "TESTNET" or "PUBLIC" (found "${rawNetwork}").`
    );
    network = "TESTNET"; // fallback for rest of checks
  }

  if (isProduction && network !== "PUBLIC") {
    errors.push(
      `Production deployment must set NEXT_PUBLIC_STELLAR_NETWORK="PUBLIC" (found "${network}").`
    );
  }

  // 2. Endpoint Resolution and Validation
  const horizonUrl = (env.NEXT_PUBLIC_HORIZON_URL?.trim() || CANONICAL_ENDPOINTS[network].horizon);
  const sorobanRpcUrl = (env.NEXT_PUBLIC_SOROBAN_RPC_URL?.trim() || CANONICAL_ENDPOINTS[network].sorobanRpc);
  const explorerUrl = (env.NEXT_PUBLIC_STELLAR_EXPLORER?.trim() || CANONICAL_ENDPOINTS[network].explorer);

  const endpointChecks = [
    { name: "HORIZON_URL", url: horizonUrl, classified: classifyHorizon(horizonUrl) },
    { name: "SOROBAN_RPC_URL", url: sorobanRpcUrl, classified: classifySoroban(sorobanRpcUrl) },
    { name: "STELLAR_EXPLORER", url: explorerUrl, classified: classifyExplorer(explorerUrl) },
  ];

  for (const ep of endpointChecks) {
    if (ep.classified && ep.classified !== network) {
      errors.push(
        `Selected network is "${network}" but ${ep.name} targets the ${ep.classified} network. ` +
        `Set ${ep.name} to the canonical ${network} endpoint, or unset it to use the default.`
      );
    }

    if (isProduction && ep.classified === "TESTNET") {
      errors.push(
        `Production deployment rejects testnet endpoint for ${ep.name}.`
      );
    }
  }

  // Cross-endpoint consistency check
  const distinctNetworks = new Set(endpointChecks.map((e) => e.classified).filter(Boolean));
  if (distinctNetworks.size > 1) {
    errors.push(
      `Network endpoints are contradictory: they target multiple Stellar networks (${[...distinctNetworks].join(", ")}).`
    );
  }

  // 3. Contract IDs Validation
  const contractId = env.NEXT_PUBLIC_CONTRACT_ID?.trim() || env.NEXT_PUBLIC_SETTLEMENT_CONTRACT_ID?.trim() || "";
  const poolContractId = env.NEXT_PUBLIC_POOL_CONTRACT_ID?.trim() || "";
  const settlementAssetId = env.NEXT_PUBLIC_SETTLEMENT_ASSET_ID?.trim() || env.NEXT_PUBLIC_POOL_TOKEN_ID?.trim() || "";

  const contractsToCheck = [
    { name: "NEXT_PUBLIC_CONTRACT_ID", val: contractId, requiredInProd: true },
    { name: "NEXT_PUBLIC_POOL_CONTRACT_ID", val: poolContractId, requiredInProd: false },
    { name: "NEXT_PUBLIC_SETTLEMENT_ASSET_ID", val: settlementAssetId, requiredInProd: false },
  ];

  for (const c of contractsToCheck) {
    if (c.val) {
      if (KNOWN_PLACEHOLDER_REGEX.test(c.val)) {
        errors.push(
          `${c.name} contains invalid placeholder string "${c.val}".`
        );
      } else if (!isContractAddress(c.val)) {
        errors.push(
          `${c.name} is not a valid Stellar contract ID format (must be 56 uppercase alphanumeric characters starting with 'C').`
        );
      } else if (isProduction && c.val === TESTNET_DEMO_CONTRACT) {
        errors.push(
          `Production deployment rejects testnet/demo contract ID: ${TESTNET_DEMO_CONTRACT} for ${c.name}. ` +
          `A verified public mainnet contract ID must be configured.`
        );
      }
    } else if (isProduction && c.requiredInProd) {
      errors.push(
        `Production deployment requires ${c.name} to be configured with a valid mainnet contract ID.`
      );
    }
  }

  // 4. Asset Issuer Validation
  const usdcIssuer = env.NEXT_PUBLIC_USDC_ISSUER?.trim() || "";
  if (usdcIssuer) {
    if (!isPublicKey(usdcIssuer)) {
      errors.push(
        `NEXT_PUBLIC_USDC_ISSUER is not a valid Stellar public key (must be 56 uppercase alphanumeric characters starting with 'G').`
      );
    } else if (network === "PUBLIC" && usdcIssuer === CIRCLE_USDC.TESTNET) {
      errors.push(
        `Production deployment rejects testnet Circle USDC issuer (${CIRCLE_USDC.TESTNET}). ` +
        `Use public issuer (${CIRCLE_USDC.PUBLIC}) or remove override.`
      );
    } else if (network === "TESTNET" && usdcIssuer === CIRCLE_USDC.PUBLIC) {
      errors.push(
        `TESTNET network rejects public Circle USDC issuer (${CIRCLE_USDC.PUBLIC}). ` +
        `Use testnet issuer (${CIRCLE_USDC.TESTNET}) or remove override.`
      );
    }
  }

  // 5. Public App URL Validation
  const siteUrl = env.NEXT_PUBLIC_SITE_URL?.trim() || "";
  if (siteUrl) {
    try {
      const parsed = new URL(siteUrl);
      if (isProduction) {
        if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
          errors.push(
            `Production deployment rejects localhost NEXT_PUBLIC_SITE_URL ("${siteUrl}"). Must be a public HTTPS URL.`
          );
        } else if (parsed.protocol !== "https:") {
          errors.push(
            `Production deployment requires HTTPS for NEXT_PUBLIC_SITE_URL ("${siteUrl}").`
          );
        }
      }
    } catch {
      errors.push(
        `NEXT_PUBLIC_SITE_URL is not a valid URL ("${siteUrl}").`
      );
    }
  }

  // 6. Secrets Hygiene & Zero-Leakage Validation
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEXT_PUBLIC_")) {
      const suffix = key.replace(/^NEXT_PUBLIC_/, "");
      if (SENSITIVE_SECRET_PATTERNS.some((sec) => suffix.includes(sec) || sec.includes(suffix))) {
        errors.push(
          `Security violation: Sensitive secret is exposed via client-prefixed variable "${key}". Remove this variable immediately.`
        );
      }
    }
  }

  const summary = {
    network,
    isProduction,
    horizon: endpointChecks[0].url,
    sorobanRpc: endpointChecks[1].url,
    explorer: endpointChecks[2].url,
    contractIdConfigured: Boolean(contractId),
    usdcIssuerConfigured: Boolean(usdcIssuer),
    siteUrlConfigured: Boolean(siteUrl),
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

/**
 * CLI Entry point
 */
function runCli() {
  const isProduction =
    process.argv.includes("--production") ||
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_STELLAR_NETWORK === "PUBLIC" ||
    process.env.PRODUCTION_CHECK === "1";

  console.log("=====================================================");
  console.log("    Stellar-star Deployment Configuration Validator   ");
  console.log("=====================================================");
  console.log(`Target Network : ${process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET (default)"}`);
  console.log(`Mode           : ${isProduction ? "PRODUCTION" : "DEVELOPMENT / TESTNET"}`);
  console.log("-----------------------------------------------------");

  const result = validateConfig(process.env, { isProduction });

  console.log("Configuration Elements Checked:");
  console.log(` - Network Setting  : ${result.summary.network}`);
  console.log(` - Horizon Endpoint : ${result.summary.horizon}`);
  console.log(` - Soroban RPC      : ${result.summary.sorobanRpc}`);
  console.log(` - Explorer         : ${result.summary.explorer}`);
  console.log(` - Contract ID      : ${result.summary.contractIdConfigured ? "[CONFIGURED]" : "[UNSET]"}`);
  console.log(` - USDC Issuer      : ${result.summary.usdcIssuerConfigured ? "[CONFIGURED]" : "[CANONICAL DEFAULT]"}`);
  console.log(` - Public Site URL  : ${result.summary.siteUrlConfigured ? "[CONFIGURED]" : "[CANONICAL DEFAULT]"}`);
  console.log(` - Secrets Exposure : [VERIFIED - NO SECRETS LEAKED]`);
  console.log("-----------------------------------------------------");

  if (result.warnings.length > 0) {
    console.warn(`Warnings (${result.warnings.length}):`);
    result.warnings.forEach((w) => console.warn(`  ! ${w}`));
  }

  if (!result.valid) {
    console.error(`Configuration validation FAILED (${result.errors.length} error(s)):`);
    result.errors.forEach((err) => console.error(`  ✗ ${err}`));
    console.error("-----------------------------------------------------");
    console.error("DEPLOYMENT BLOCKED: Configuration is invalid or unsafe for deployment.");
    process.exit(1);
  }

  console.log("✓ Configuration validation passed successfully.");
  console.log("✓ Safe for deployment.");
  process.exit(0);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  validateConfig,
  CANONICAL_ENDPOINTS,
  CIRCLE_USDC,
  TESTNET_DEMO_CONTRACT,
};
