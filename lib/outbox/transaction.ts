/**
 * lib/outbox/transaction.ts
 *
 * Transactional wrappers & event builders for Transactional Outbox (#425).
 *
 * Couples state mutations with outbox row creation to solve the dual-write hazard:
 * if the subsequent webhook, reminder, or analytics call fails after commit,
 * the leased worker guarantees eventual delivery.
 */

import {
  type OutboxEvent,
  type OutboxEventInsert,
  type OutboxChannel,
} from "./types";
import { enqueueOutboxBatch, enqueueOutboxEvent } from "./repository";
import { type StellarStarClient } from "@/lib/supabase/client";

/**
 * Executes a financial state mutation and durably writes its outbox consequences.
 * Even if downstream dispatch fails after the mutation commits, the outbox rows
 * guarantee eventual delivery through leased workers.
 */
export async function withTransactionalOutbox<T>(
  mutation: () => Promise<T>,
  outboxFactory: (result: T) => OutboxEventInsert | OutboxEventInsert[],
  client?: StellarStarClient
): Promise<{ result: T; outboxEvents: OutboxEvent[] }> {
  // 1. Commit the state mutation
  const result = await mutation();

  // 2. Persist outbox consequence rows
  const rawEvents = outboxFactory(result);
  const eventsToInsert = Array.isArray(rawEvents) ? rawEvents : [rawEvents];

  const outboxEvents = await enqueueOutboxBatch(eventsToInsert, client);

  return { result, outboxEvents };
}

// ─── Event Builders ──────────────────────────────────────────────────────────

export function buildExpenseCreatedOutboxEvent(params: {
  expenseId: string;
  tripId: string;
  title: string;
  totalAmount: string; // Preserved decimal-string
  currency: string;
  createdAt: string;
  createdByWallet: string;
  traceId: string;
  channel?: OutboxChannel;
}): OutboxEventInsert {
  const channel = params.channel ?? "webhook";
  return {
    aggregateType: "expense",
    aggregateId: params.expenseId,
    eventType: "expense.created",
    channel,
    payload: {
      expense_id: params.expenseId,
      trip_id: params.tripId,
      title: params.title,
      total_amount: String(params.totalAmount),
      currency: params.currency,
      created_at: params.createdAt,
    },
    traceId: params.traceId,
    deduplicationKey: `outbox:${channel}:expense:${params.expenseId}:created`,
    createdByWallet: params.createdByWallet,
  };
}

export function buildSettlementRecordedOutboxEvent(params: {
  intentId: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  payerWallet: string;
  memberWallet: string;
  amount: string; // Preserved decimal-string
  currency: string;
  txHash: string;
  ledger?: number | null;
  traceId: string;
  createdByWallet: string;
  channel?: OutboxChannel;
}): OutboxEventInsert {
  const channel = params.channel ?? "webhook";
  return {
    aggregateType: "settlement",
    aggregateId: params.intentId,
    eventType: "settlement.recorded",
    channel,
    payload: {
      intent_id: params.intentId,
      trip_id: params.tripId,
      expense_id: params.expenseId,
      member_id: params.memberId,
      payer_wallet: params.payerWallet,
      member_wallet: params.memberWallet,
      amount: String(params.amount),
      currency: params.currency,
      tx_hash: params.txHash,
      ledger: params.ledger ?? null,
    },
    traceId: params.traceId,
    deduplicationKey: `outbox:${channel}:settlement:${params.intentId}:recorded`,
    createdByWallet: params.createdByWallet,
  };
}

export function buildReminderOutboxEvent(params: {
  reminderId: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  senderWallet: string;
  recipientWallet: string;
  amount: string; // Preserved decimal-string
  currency: string;
  channelName: string;
  traceId: string;
}): OutboxEventInsert {
  return {
    aggregateType: "reminder",
    aggregateId: params.reminderId,
    eventType: "reminder.dispatched",
    channel: "reminder",
    payload: {
      reminder_id: params.reminderId,
      trip_id: params.tripId,
      expense_id: params.expenseId,
      member_id: params.memberId,
      sender_wallet: params.senderWallet,
      recipient_wallet: params.recipientWallet,
      amount: String(params.amount),
      currency: params.currency,
      channel: params.channelName,
    },
    traceId: params.traceId,
    deduplicationKey: `outbox:reminder:expense:${params.expenseId}:share:${params.memberId}:${params.reminderId}`,
    createdByWallet: params.senderWallet,
  };
}

export function buildAnalyticsOutboxEvent(params: {
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  properties: Record<string, unknown>;
  traceId: string;
  walletAddress?: string | null;
}): OutboxEventInsert {
  return {
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    eventType: params.eventName,
    channel: "analytics",
    payload: {
      event_name: params.eventName,
      properties: params.properties,
    },
    traceId: params.traceId,
    deduplicationKey: `outbox:analytics:${params.aggregateType}:${params.aggregateId}:${params.eventName}`,
    createdByWallet: params.walletAddress,
  };
}
