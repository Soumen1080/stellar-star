import { rpc, xdr, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { sorobanServer } from "./soroban";
import { CONTRACT_ID } from "@/lib/utils/constants";
import type { ContractPaymentEvent } from "@/types/contract";

const LOOKBACK_LEDGERS = 600;
const EVENT_PAGE_LIMIT = 200;

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

export function buildPaymentEventKey(event: ContractPaymentEvent): string {
  return `${event.tripId}:${event.expenseId}:${event.member.toLowerCase()}:${event.amountStroops}:native`;
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
    let member        = "";
    let amountStroops = "0";

    if (Array.isArray(valueNative) && valueNative.length >= 3) {
      expenseId     = String(valueNative[0] ?? "");
      member        = String(valueNative[1] ?? "");
      amountStroops = String(valueNative[2] ?? "0");
    } else if (valueNative && typeof valueNative === "object") {
      const obj = valueNative as Record<string, unknown>;
      expenseId = String(obj.expense_id ?? obj.expenseId ?? "");
      member = String(obj.member ?? "");
      amountStroops = String(obj.amount ?? obj.amount_stroops ?? "0");
    }

    return {
      ledger:         Number(raw.ledger ?? 0),
      ledgerClosedAt: String(raw.ledgerClosedAt ?? ""),
      tripId:         eventTripId,
      expenseId,
      member,
      amountStroops,
      txHash:         String(raw.txHash ?? ""),
    };
  } catch {
    return null;
  }
}

export async function fetchContractEvents(
  startLedger: number,
  tripId?: string,
): Promise<{ events: ContractPaymentEvent[]; latestLedger: number }> {
  if (!CONTRACT_ID) {
    return { events: [], latestLedger: startLedger };
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

    while (true) {
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

      const nextCursor = typeof response?.cursor === "string" ? response.cursor : undefined;
      const shouldContinue = pageEvents.length === EVENT_PAGE_LIMIT && Boolean(nextCursor);

      if (!shouldContinue) break;

      cursor = nextCursor;
    }

    const events: ContractPaymentEvent[] = rawEvents
      .map((ev: any) => parsePaymentEvent(ev))
      .filter((e): e is ContractPaymentEvent => e !== null && !!e.tripId);

    return { events, latestLedger };
  } catch (err) {
    console.warn("[StellarStar] fetchContractEvents error:", err);
    return { events: [], latestLedger: startLedger };
  }
}
