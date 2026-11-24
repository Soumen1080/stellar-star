# Operational Runbook: Provider Health Routing & Failover Management

## 1. Overview & Problem Statement

Depending on a single vendor for Stellar RPC, foreign exchange rates (FX), receipt OCR, or push/email notifications transforms any third-party outage into a total application failure.

To address **Issue #428**, StellarStar implements **Provider Health Routing**:
- **Health-checked provider interfaces** monitoring latency, consecutive failures, and availability.
- **Ordered compatible fallbacks** directing traffic automatically to secondary providers when primaries degrade.
- **Strict consistency rules**: not every provider can safely substitute for payment submission. Routing eliminates duplicate payment effects during failover.
- **Operator controls & dashboard**: staff can view vendor health and deliberately disable flapping providers.

---

## 2. Vendor Domains & Hierarchy

| Domain | Provider ID | Name | Priority | Capabilities | Fallback Role |
|---|---|---|---|---|---|
| **Stellar** | `stellar-primary-sdf` | SDF Official Horizon | P1 | `read`, `simulate`, `submit` | Primary network gateway |
| **Stellar** | `stellar-backup-public` | Public Backup Horizon | P2 | `read`, `simulate`, `submit` | Standby failover node |
| **Stellar** | `soroban-rpc-primary` | Soroban RPC Node | P1 | `simulate` | Smart contract simulation |
| **FX** | `fx-coingecko` | CoinGecko | P1 | `crypto`, `fiat` | Primary crypto & fiat rates |
| **FX** | `fx-exchangerate` | ExchangeRate-API | P2 | `fiat` | Secondary fiat rate provider |
| **OCR** | `ocr-client-worker` | In-Browser Tesseract Worker | P1 | `client` | Zero-cost client-side processing |
| **OCR** | `ocr-cloud-fallback` | Cloud Vision Analyzer | P2 | `cloud` | Server-side image parsing |
| **Notification** | `notification-webhook-primary` | Primary Relay | P1 | `email`, `push`, `webhook` | Transactional email & push |
| **Notification** | `notification-relay-backup` | Backup Relay | P2 | `email`, `push`, `webhook` | Disaster-recovery relay |

---

## 3. Consistency Rules & Payment Submission Safety

### The Golden Rule
> **Not every provider can safely substitute for payment submission.**
> Read operations (balances, ledger state, FX quotes) can failover immediately and idempotently. Payment submissions mutate financial balances and **must never duplicate effects during failover**.

### Failover Safety Protocol
1. **Capability Gate:** The router asserts `provider.capabilities.includes("stellar:submit")`. Read-only or simulation-only nodes are strictly rejected for payment transactions (`IncompatibleProviderError`).
2. **Transaction Hash Tracking:** Every submission is keyed by its unique cryptographic transaction hash (`txHash`). In-flight submissions are coalesced to prevent duplicate simultaneous executions.
3. **On-Chain Pre-Verification on Timeout:** If Horizon Primary times out or drops a socket connection:
   - Before submitting to Horizon Backup, the failover router executes `verifyTxExists(txHash)` against the network ledger.
   - If the transaction has already been included on a ledger, failover **aborts submission** and returns the confirmed transaction hash immediately (`DuplicatePaymentPreventedError` caught and handled as success).
   - This eliminates race conditions where both primary and backup execute payments, avoiding double-spend errors and duplicate fees.

---

## 4. Health Evaluation & Circuit Thresholds

- **Health Probing:** Probes run every 15 seconds or on-demand via the dashboard or API.
- **Degraded Status:** Triggered if average latency exceeds 2,500ms or 1–2 consecutive requests fail.
- **Unhealthy Status:** Triggered when 3 consecutive requests or health checks fail. The provider is removed from the active routing candidate pool.
- **Automatic Recovery:** When an unhealthy provider records 2 consecutive successful health checks, it is re-admitted to active rotation.

---

## 5. Staff Incident Response & Manual Disablement

When a third-party vendor is flapping, rate-limiting, or returning corrupted responses, operators can instantly disable it:

### Via Dashboard
1. Navigate to `/developer/providers`.
2. Locate the problematic vendor row.
3. Click **Disable**. Traffic immediately diverts to the secondary fallback without service restart.
4. Once the vendor resolves their outage, click **Enable** to re-enter rotation.

### Via API / CLI
```bash
# Deliberately disable flapping primary Horizon provider
curl -X POST /api/developer/providers \
  -H "Content-Type: application/json" \
  -d '{"action": "toggle", "providerId": "stellar-primary-sdf", "disabled": true}'

# Trigger immediate health re-check
curl -X POST /api/developer/providers \
  -H "Content-Type: application/json" \
  -d '{"action": "check"}'
```

---

## 6. Failure Fixtures & Validation

Automated failure fixtures in `__tests__/routing/providerHealthRouting.test.ts` continuously validate:
- Primary vendor crash -> instant secondary fallback.
- Read failover vs payment submission failover semantics.
- Prevention of duplicate payments when network timeouts occur.
- Manual disablement and recovery re-admission.
