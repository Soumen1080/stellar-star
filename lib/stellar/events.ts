import { rpc, xdr, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { sorobanServer } from "./soroban";
import { CONTRACT_ID } from "@/lib/utils/constants";
import type { ContractPaymentEvent } from "@/types/contract";
import {
  assetKey,
  parseAssetKey,
  tryParseAssetKey,
  NATIVE_ASSET_KEY,
  type AssetRef,
} from "@/lib/stellar/assets";

const LOOKBACK_LEDGERS = 600;
const EVENT_PAGE_LIMIT = 200;
const MAX_PAGES = 50;

/**
 * Soroban RPC only retains events for a limited window (~24h on public
 * infrastructure). When `startLedger` falls outside it, the node rejects the
 * request rather than returning a truncated result. We detect that explicitly
 * so callers can fall back to the durable contract-state path instead of
 * treating "no events" as "nothing was paid".
 */
const RETENTION_ERROR_RE =
  /start\s*ledger|startLedger|not\s*(?:available|found)|outside|retention|older than|must be (?:within|between)|-32600|ledger.*(?:pruned|unavailable)/i;

export function isRetentionWindowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return RETENTION_ERROR_RE.test(msg);
}

type RawEventLike = {
  ledger?: number;
  ledgerClosedAt?: string;
  txHash?: string;
  topic?: unknown[];
  value?: unknown;
};

type EventsPage = {
  events?: unknown[];
  latestLedger?: number;
  cursor?: string;
};

export interface PaymentKeyInput {
  tripId: string;
  expenseId: string;
  member: string;
  amountStroops: string | bigint | number;
  asset?: string | AssetRef | null;
}

/**
 * Builds a deterministic, collision-free key for matching on-chain payments to expenses.
 *
 * Invariant: Matching is exact on (tripId, expenseId, debtor member, amount in stroops, canonical asset).
 * A 10 USDC payment and a 10 XLM payment on the same expense will yield distinct keys and never collide.
 */
export function buildPaymentEventKey(event: PaymentKeyInput): string {
  const memberLower = (event.member ?? "").trim().toLowerCase();
  const amountStr = typeof event.amountStroops === "bigint"
    ? event.amountStroops.toString()
    : String(event.amountStroops ?? "0");

  let canonicalAsset = NATIVE_ASSET_KEY;
  if (event.asset) {
    if (typeof event.asset === "object" && event.asset !== null) {
      canonicalAsset = assetKey(event.asset);
    } else if (typeof event.asset === "string") {
      const parsed = tryParseAssetKey(event.asset);
      canonicalAsset = parsed ? assetKey(parsed) : event.asset.trim();
    }
  }

  return `${event.tripId}:${event.expenseId}:${memberLower}:${amountStr}:${canonicalAsset}`;
}

export function parsePaymentEvent(raw: RawEventLike): ContractPaymentEvent | null {
  try {
    const topicScVals = Array.isArray(raw.topic) ? raw.topic : [];
    const eventTripId = topicScVals[1]
      ? String(scValToNative(topicScVals[1] as any))
      : "";

    if (!eventTripId) return null;

    const valueNative = raw.value ? scValToNative(raw.value as any) : null;

    let expenseId     = "";
    let payer         = "";
    let member        = "";
    let amountStroops = "0";
    let asset         = NATIVE_ASSET_KEY;
    let txHash        = String(raw.txHash ?? "");
    let timestamp: number | undefined;

    if (Array.isArray(valueNative)) {
      expenseId     = String(valueNative[0] ?? "");
      member        = String(valueNative[1] ?? "");
      amountStroops = String(valueNative[2] ?? "0");
      if (valueNative.length > 3 && valueNative[3]) {
        const parsed = tryParseAssetKey(String(valueNative[3]));
        asset = parsed ? assetKey(parsed) : String(valueNative[3]);
      }
      if (valueNative.length > 4 && valueNative[4]) {
        payer = String(valueNative[4]);
      }
      if (valueNative.length > 5 && valueNative[5]) {
        txHash = String(valueNative[5]);
      }
    } else if (valueNative && typeof valueNative === "object") {
      const obj = valueNative as Record<string, unknown>;
      expenseId     = String(obj.expense_id ?? obj.expenseId ?? "");
      member        = String(obj.member ?? "");
      payer         = String(obj.payer ?? "");
      amountStroops = String(obj.amount ?? obj.amount_stroops ?? "0");
      if (obj.asset) {
        const parsed = tryParseAssetKey(String(obj.asset));
        asset = parsed ? assetKey(parsed) : String(obj.asset);
      }
      if (obj.tx_hash ?? obj.txHash) {
        txHash = String(obj.tx_hash ?? obj.txHash);
      }
      if (obj.timestamp !== undefined) {
        timestamp = Number(obj.timestamp);
      }
    }

    return {
      ledger:         Number(raw.ledger ?? 0),
      ledgerClosedAt: String(raw.ledgerClosedAt ?? ""),
      tripId:         eventTripId,
      expenseId,
      payer:          payer || undefined,
      member,
      amountStroops,
      asset,
      txHash,
      timestamp,
    };
  } catch {
    return null;
  }
}

export interface FetchEventsResult {
  events: ContractPaymentEvent[];
  latestLedger: number;
  /**
   * True when the requested `startLedger` fell outside the RPC retention
   * window. Events are unavailable for that range *forever*; the caller must
   * reconcile from durable contract state instead.
   */
  retentionExpired: boolean;
  /**
   * True when pagination stopped at MAX_PAGES with a cursor still outstanding,
   * i.e. records past the page budget were not read. Callers must not treat the
   * returned set as complete.
   */
  truncated: boolean;
  error?: string;
}

export async function fetchContractEvents(
  startLedger: number,
  tripId?: string,
): Promise<FetchEventsResult> {
  if (!CONTRACT_ID) {
    return { events: [], latestLedger: startLedger, retentionExpired: false, truncated: false };
  }

  try {
    let fromLedger = startLedger;

    if (!fromLedger) {
      const latest = await sorobanServer.getLatestLedger();
      fromLedger = Math.max(1, latest.sequence - LOOKBACK_LEDGERS);
    }

    const server = sorobanServer as rpc.Server;

    const symbolXdr = xdr.ScVal.scvSymbol("pmt_rec").toXDR("base64");
    const tripTopicXdr = tripId
      ? nativeToScVal(tripId, { type: "string" }).toXDR("base64")
      : "*";

    const filters = [
      {
        type:        "contract",
        contractIds: [CONTRACT_ID],
        topics:      [[symbolXdr, tripTopicXdr]],
      },
    ];

    const rawEvents: unknown[] = [];
    let latestLedger = fromLedger;
    let cursor: string | undefined;
    let pageCount = 0;
    let truncated = false;

    // Exhaustive pagination: follow the cursor until the server stops handing
    // one back. A short page is NOT an end-of-stream signal — RPC may return
    // fewer than `limit` records and still have more behind the cursor — so the
    // cursor alone terminates the walk.
    for (;;) {
      pageCount++;
      const response = await (server as any).getEvents({
        ...(cursor ? {} : { startLedger: fromLedger }),
        filters,
        pagination: {
          ...(cursor ? { cursor } : {}),
          limit: EVENT_PAGE_LIMIT,
        },
      }) as EventsPage;

      const pageEvents = Array.isArray(response?.events) ? response.events : [];
      rawEvents.push(...pageEvents);

      if (typeof response?.latestLedger === "number" && response.latestLedger > latestLedger) {
        latestLedger = response.latestLedger;
      }

      const nextCursor = typeof response?.cursor === "string" && response.cursor
        ? response.cursor
        : undefined;

      // No cursor, or a cursor that did not advance, means the stream is drained.
      if (!nextCursor || nextCursor === cursor) break;

      cursor = nextCursor;

      if (pageCount >= MAX_PAGES) {
        // Budget exhausted with records still outstanding. Report it rather
        // than silently dropping them — the caller falls back to contract state.
        truncated = true;
        console.warn(
          `[StellarStar] fetchContractEvents: page budget (${MAX_PAGES}) exhausted for trip ${tripId ?? "*"}; results truncated.`,
        );
        break;
      }
    }

    const events: ContractPaymentEvent[] = rawEvents
      .map((ev: any) => parsePaymentEvent(ev))
      .filter((e): e is ContractPaymentEvent => e !== null && !!e.tripId);

    return { events, latestLedger, retentionExpired: false, truncated };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const retentionExpired = isRetentionWindowError(err);

    if (!retentionExpired) {
      console.warn("[StellarStar] fetchContractEvents error:", errorMsg);
    }

    // startLedger outside the retention window is expected for older trips and
    // is not an error condition — it is the signal to reconcile from state.
    return {
      events: [],
      latestLedger: startLedger,
      retentionExpired,
      truncated: false,
      error: errorMsg,
    };
  }
}
