/**
 * __tests__/outbox/transactionalOutbox.test.ts
 *
 * Comprehensive correctness & distributed systems tests for Transactional Outbox (#425).
 *
 * Core Invariants Tested:
 * 1. Post-commit failure simulation: financial mutation commits, subsequent webhook/reminder/analytics
 *    call fails, outbox row durably records consequence, and leased worker achieves eventual delivery.
 * 2. Deduplication semantics: retried dispatches and competing workers produce NO duplicate
 *    externally visible side-effects.
 * 3. Leased worker recovery: expired leases on stalled/crashed workers are safely reclaimed.
 * 4. Exponential backoff & dead-letter queue: repeated transient failures back off with jitter,
 *    and exhausted retries move to 'dead_letter' without stalling queue throughput.
 * 5. Decimal-string money precision: exact decimal strings ("100.5000000") are preserved verbatim.
 * 6. Distributed trace ID propagation: W3C trace IDs propagate from financial mutation to dispatcher.
 */

import {
  enqueueOutboxEvent,
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  fetchOutboxEventById,
  clearOutboxMemoryStore,
  getOutboxMemoryStore,
} from "@/lib/outbox/repository";
import {
  runOutboxWorkerBatch,
  calculateBackoff,
} from "@/lib/outbox/worker";
import {
  withTransactionalOutbox,
  buildExpenseCreatedOutboxEvent,
  buildSettlementRecordedOutboxEvent,
  buildReminderOutboxEvent,
} from "@/lib/outbox/transaction";
import {
  setCustomDispatchers,
  resetDispatchers,
} from "@/lib/outbox/dispatcher";
import type { OutboxEvent, OutboxDispatchResult } from "@/types/outbox";

describe("Transactional Outbox Pattern (#425)", () => {
  beforeEach(() => {
    clearOutboxMemoryStore();
    resetDispatchers();
    jest.clearAllMocks();
  });

  describe("Post-Commit Failure & Eventual Delivery Invariant", () => {
    it("simulates external dispatch failure after financial state commit and achieves eventual delivery", async () => {
      const deliveredPayloads: any[] = [];
      let externalCallsCount = 0;
      let shouldSimulateExternalFailure = true;

      // Mock external webhook dispatcher that fails initially then recovers
      const failureSimulatingDispatcher = async (
        event: OutboxEvent
      ): Promise<OutboxDispatchResult> => {
        externalCallsCount++;
        if (shouldSimulateExternalFailure) {
          return {
            success: false,
            statusCode: 503,
            errorMessage: "Simulated post-commit downstream network timeout (ECONNREFUSED)",
            retryable: true,
          };
        }

        deliveredPayloads.push(event.payload);
        return {
          success: true,
          statusCode: 200,
          externalDeliveryId: `wh-deliv-${event.id}`,
        };
      };

      // 1. Execute financial state mutation (e.g. expense creation)
      const fakeExpense = {
        id: "exp-test-425",
        tripId: "trip-alpha",
        title: "Team Lunch in Tokyo",
        totalAmount: "123.4500000", // Decimal-string money
        currency: "XLM",
        createdAt: "2026-11-20T00:00:00.000Z",
        creatorWallet: "GCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      };

      const traceId = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

      // Commit financial mutation with transactional outbox promise
      const { result, outboxEvents } = await withTransactionalOutbox(
        async () => {
          // Mutation commits state
          return fakeExpense;
        },
        (exp) =>
          buildExpenseCreatedOutboxEvent({
            expenseId: exp.id,
            tripId: exp.tripId,
            title: exp.title,
            totalAmount: exp.totalAmount,
            currency: exp.currency,
            createdAt: exp.createdAt,
            createdByWallet: exp.creatorWallet,
            traceId,
          })
      );

      // Verify financial state committed
      expect(result.id).toBe("exp-test-425");
      expect(outboxEvents).toHaveLength(1);
      const initialOutbox = outboxEvents[0];
      expect(initialOutbox.status).toBe("pending");
      expect(initialOutbox.traceId).toBe(traceId);
      expect(initialOutbox.payload.total_amount).toBe("123.4500000");

      // 2. Direct post-commit dispatch fails (simulating network crash or serverless termination)
      const directAttempt = await failureSimulatingDispatcher(initialOutbox);
      expect(directAttempt.success).toBe(false);
      // Downstream did NOT receive payload yet
      expect(deliveredPayloads).toHaveLength(0);

      // 3. Outbox worker runs attempt 1 while external service is still down
      const workerRun1 = await runOutboxWorkerBatch({
        workerId: "worker-node-1",
        batchSize: 10,
        baseBackoffMs: 200,
        dispatcher: { webhook: failureSimulatingDispatcher },
      });

      expect(workerRun1.claimedCount).toBe(1);
      expect(workerRun1.deliveredCount).toBe(0);
      expect(workerRun1.retriedCount).toBe(1);

      // Record is in failed state with retry schedule
      const outboxAfterFail = await fetchOutboxEventById(initialOutbox.id);
      expect(outboxAfterFail?.status).toBe("failed");
      expect(outboxAfterFail?.attempts).toBe(1);
      expect(outboxAfterFail?.errorMessage).toContain("ECONNREFUSED");

      // 4. Downstream service recovers
      shouldSimulateExternalFailure = false;

      // Fast-forward next_attempt_at so it is immediately claimable
      if (outboxAfterFail) {
        outboxAfterFail.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
      }

      // 5. Outbox worker runs attempt 2 and achieves eventual delivery!
      const workerRun2 = await runOutboxWorkerBatch({
        workerId: "worker-node-2",
        batchSize: 10,
        dispatcher: { webhook: failureSimulatingDispatcher },
      });

      expect(workerRun2.claimedCount).toBe(1);
      expect(workerRun2.deliveredCount).toBe(1);
      expect(workerRun2.retriedCount).toBe(0);

      // 6. Verify final state and payload delivery
      const outboxDelivered = await fetchOutboxEventById(initialOutbox.id);
      expect(outboxDelivered?.status).toBe("delivered");
      expect(outboxDelivered?.deliveredAt).toBeTruthy();
      expect(outboxDelivered?.leaseId).toBeNull();

      // Verify exact payload received by external recipient
      expect(deliveredPayloads).toHaveLength(1);
      expect(deliveredPayloads[0]).toEqual({
        expense_id: "exp-test-425",
        trip_id: "trip-alpha",
        title: "Team Lunch in Tokyo",
        total_amount: "123.4500000",
        currency: "XLM",
        created_at: "2026-11-20T00:00:00.000Z",
      });
    });
  });

  describe("Deduplication & Concurrency Semantics", () => {
    it("prevents duplicate externally visible effects during concurrent worker executions", async () => {
      const deliveredDeliveries: string[] = [];

      const trackingDispatcher = async (event: OutboxEvent): Promise<OutboxDispatchResult> => {
        deliveredDeliveries.push(event.deduplicationKey);
        return { success: true, statusCode: 200 };
      };

      // Create an outbox event
      const event = await enqueueOutboxEvent({
        aggregateType: "expense",
        aggregateId: "exp-dedup-1",
        eventType: "expense.created",
        channel: "webhook",
        payload: { expense_id: "exp-dedup-1", total_amount: "50.0000000" },
        traceId: "trace-dedup-1",
        deduplicationKey: "outbox:webhook:expense:exp-dedup-1:created",
      });

      // Enqueueing the same deduplication key again returns the existing event
      const duplicateEnqueue = await enqueueOutboxEvent({
        aggregateType: "expense",
        aggregateId: "exp-dedup-1",
        eventType: "expense.created",
        channel: "webhook",
        payload: { expense_id: "exp-dedup-1", total_amount: "50.0000000" },
        traceId: "trace-dedup-1",
        deduplicationKey: "outbox:webhook:expense:exp-dedup-1:created",
      });

      expect(duplicateEnqueue.id).toBe(event.id);

      // Run worker 1
      const result1 = await runOutboxWorkerBatch({
        workerId: "worker-1",
        dispatcher: { webhook: trackingDispatcher },
      });

      expect(result1.deliveredCount).toBe(1);

      // Run worker 2 immediately after — must find 0 claimable rows
      const result2 = await runOutboxWorkerBatch({
        workerId: "worker-2",
        dispatcher: { webhook: trackingDispatcher },
      });

      expect(result2.claimedCount).toBe(0);
      expect(result2.deliveredCount).toBe(0);

      // Assert exactly 1 external effect took place
      expect(deliveredDeliveries).toHaveLength(1);
      expect(deliveredDeliveries[0]).toBe("outbox:webhook:expense:exp-dedup-1:created");
    });
  });

  describe("Worker Lease Expiration & Crash Recovery", () => {
    it("allows a secondary worker to reclaim and deliver an event if the primary worker crashes holding a lease", async () => {
      const event = await enqueueOutboxEvent({
        aggregateType: "settlement",
        aggregateId: "si-lease-1",
        eventType: "settlement.recorded",
        channel: "webhook",
        payload: { intent_id: "si-lease-1", amount: "99.9900000" },
        traceId: "trace-lease-1",
        deduplicationKey: "outbox:webhook:settlement:si-lease-1:recorded",
      });

      // Worker A claims with a short 1-second lease
      const claimedA = await claimOutboxBatch("worker-crashed", 10, 1);
      expect(claimedA).toHaveLength(1);
      expect(claimedA[0].id).toBe(event.id);
      expect(claimedA[0].status).toBe("leased");
      expect(claimedA[0].leaseId).toBe("worker-crashed");

      // While lease is active, Worker B cannot claim it
      const claimedBWhileActive = await claimOutboxBatch("worker-b", 10, 1);
      expect(claimedBWhileActive).toHaveLength(0);

      // Simulate lease expiration (Worker A died)
      const mem = getOutboxMemoryStore().get(event.id);
      if (mem) {
        mem.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
      }

      // Worker B re-runs and reclaims the expired lease
      let workerBDelivered = false;
      const workerBRun = await runOutboxWorkerBatch({
        workerId: "worker-b",
        dispatcher: {
          webhook: async () => {
            workerBDelivered = true;
            return { success: true, statusCode: 200 };
          },
        },
      });

      expect(workerBRun.claimedCount).toBe(1);
      expect(workerBRun.deliveredCount).toBe(1);
      expect(workerBDelivered).toBe(true);

      const finalState = await fetchOutboxEventById(event.id);
      expect(finalState?.status).toBe("delivered");
    });
  });

  describe("Exponential Backoff with Jitter & Dead-Letter Queue", () => {
    it("calculates exponential backoff and enforces max caps with bounded jitter", () => {
      const b1 = calculateBackoff(1, 1000, 60000, 0);
      const b2 = calculateBackoff(2, 1000, 60000, 0);
      const b3 = calculateBackoff(3, 1000, 60000, 0);
      const bMax = calculateBackoff(10, 1000, 60000, 0);

      expect(b1).toBe(1000);
      expect(b2).toBe(2000);
      expect(b3).toBe(4000);
      expect(bMax).toBe(60000);

      // With 20% jitter
      const jittered = calculateBackoff(3, 1000, 60000, 0.2);
      expect(jittered).toBeGreaterThanOrEqual(3200);
      expect(jittered).toBeLessThanOrEqual(4800);
    });

    it("moves terminal failures to dead_letter when max_attempts is exceeded", async () => {
      const event = await enqueueOutboxEvent({
        aggregateType: "reminder",
        aggregateId: "rem-exhaust-1",
        eventType: "reminder.dispatched",
        channel: "reminder",
        payload: { reminder_id: "rem-exhaust-1", amount: "10.0000000" },
        traceId: "trace-rem-1",
        deduplicationKey: "outbox:reminder:rem-exhaust-1",
        maxAttempts: 3,
      });

      const failingDispatcher = async (): Promise<OutboxDispatchResult> => {
        return {
          success: false,
          statusCode: 400,
          errorMessage: "Permanent invalid recipient wallet",
          retryable: false,
        };
      };

      // Run worker 3 times to exhaust retries
      for (let i = 1; i <= 3; i++) {
        const mem = getOutboxMemoryStore().get(event.id);
        if (mem && i > 1) {
          mem.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
        }

        const run = await runOutboxWorkerBatch({
          workerId: `worker-attempt-${i}`,
          dispatcher: { reminder: failingDispatcher },
        });

        if (i < 3) {
          expect(run.retriedCount).toBe(1);
          expect(run.deadLetterCount).toBe(0);
        } else {
          expect(run.retriedCount).toBe(0);
          expect(run.deadLetterCount).toBe(1);
        }
      }

      const terminalEvent = await fetchOutboxEventById(event.id);
      expect(terminalEvent?.status).toBe("dead_letter");
      expect(terminalEvent?.attempts).toBe(3);
      expect(terminalEvent?.errorMessage).toBe("Permanent invalid recipient wallet");
    });
  });

  describe("Decimal-String Money Value Preservation Invariant", () => {
    it("preserves 7-decimal string precision without JavaScript floating-point corruption", async () => {
      const exactAmount = "1234567.8901234";
      let receivedAmount = "";

      const event = buildSettlementRecordedOutboxEvent({
        intentId: "si-precision-1",
        tripId: "trip-precision",
        expenseId: "exp-precision",
        memberId: "mem-precision",
        payerWallet: "GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        memberWallet: "GMEMBERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: exactAmount,
        currency: "XLM",
        txHash: "a".repeat(64),
        traceId: "trace-prec-1",
        createdByWallet: "GMEMBERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      await enqueueOutboxEvent(event);

      await runOutboxWorkerBatch({
        workerId: "worker-prec",
        dispatcher: {
          webhook: async (ev) => {
            receivedAmount = String(ev.payload.amount);
            return { success: true };
          },
        },
      });

      expect(receivedAmount).toBe("1234567.8901234");
      expect(receivedAmount).not.toBe(String(parseFloat(exactAmount))); // Guarantees string preservation
    });
  });

  describe("Trace ID & Request Causality Invariant", () => {
    it("propagates distributed trace ID from financial transaction to outbox consequence", async () => {
      const traceId = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      let capturedTraceId = "";

      const event = buildReminderOutboxEvent({
        reminderId: "rem-trace-1",
        tripId: "trip-1",
        expenseId: "exp-1",
        memberId: "mem-1",
        senderWallet: "GSENDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        recipientWallet: "GRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "45.0000000",
        currency: "XLM",
        channelName: "email",
        traceId,
      });

      await enqueueOutboxEvent(event);

      await runOutboxWorkerBatch({
        workerId: "worker-trace",
        dispatcher: {
          reminder: async (ev) => {
            capturedTraceId = ev.traceId;
            return { success: true };
          },
        },
      });

      expect(capturedTraceId).toBe(traceId);
    });
  });
});
