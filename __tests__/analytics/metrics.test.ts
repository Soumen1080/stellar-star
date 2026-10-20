import { computeAggregateMetrics } from "@/lib/analytics/sink";
import { type AnalyticsEvent } from "@/lib/analytics/types";

describe("Product Analytics Aggregate Metrics & Funnel Computation", () => {
  it("computes empty metrics gracefully when no events exist", () => {
    const metrics = computeAggregateMetrics([]);
    expect(metrics.totalVisitors).toBe(0);
    expect(metrics.walletConnections).toBe(0);
    expect(metrics.activationRate).toBe(0);
    expect(metrics.paymentCompletionRate).toBe(0);
    expect(metrics.failureRate).toBe(0);
    expect(metrics.redactionVerified).toBe(true);
  });

  it("calculates activation, completion, and failure rates accurately", () => {
    const sampleEvents: AnalyticsEvent[] = [
      // 10 visitors
      { id: "1", name: "app_loaded", schemaVersion: "1.0.0", timestamp: "t1", properties: { locale: "en" }, session: { id: "s1", locale: "en" } },
      { id: "2", name: "app_loaded", schemaVersion: "1.0.0", timestamp: "t2", properties: { locale: "en" }, session: { id: "s2", locale: "en" } },
      { id: "3", name: "app_loaded", schemaVersion: "1.0.0", timestamp: "t3", properties: { locale: "en" }, session: { id: "s3", locale: "en" } },
      { id: "4", name: "app_loaded", schemaVersion: "1.0.0", timestamp: "t4", properties: { locale: "en" }, session: { id: "s4", locale: "en" } },

      // 2 wallet connection attempts, 2 successes
      { id: "5", name: "wallet_connect_started", schemaVersion: "1.0.0", timestamp: "t5", properties: { wallet_type: "freighter" }, session: { id: "s1", locale: "en" } },
      { id: "6", name: "wallet_connected", schemaVersion: "1.0.0", timestamp: "t6", properties: { wallet_type: "freighter", network: "TESTNET", has_funds: true }, session: { id: "s1", locale: "en" } },
      { id: "7", name: "wallet_connect_started", schemaVersion: "1.0.0", timestamp: "t7", properties: { wallet_type: "albedo" }, session: { id: "s2", locale: "en" } },
      { id: "8", name: "wallet_connected", schemaVersion: "1.0.0", timestamp: "t8", properties: { wallet_type: "albedo", network: "TESTNET", has_funds: true }, session: { id: "s2", locale: "en" } },

      // 1 trip created
      { id: "9", name: "trip_created", schemaVersion: "1.0.0", timestamp: "t9", properties: { member_count: 3, has_destination: true }, session: { id: "s1", locale: "en" } },

      // 2 expenses started, 2 created (100% completion)
      { id: "10", name: "expense_create_started", schemaVersion: "1.0.0", timestamp: "t10", properties: { currency: "XLM" }, session: { id: "s1", locale: "en" } },
      { id: "11", name: "expense_created", schemaVersion: "1.0.0", timestamp: "t11", properties: { split_mode: "equal", currency: "XLM", member_count: 3 }, session: { id: "s1", locale: "en" } },
      { id: "12", name: "expense_create_started", schemaVersion: "1.0.0", timestamp: "t12", properties: { currency: "USD" }, session: { id: "s2", locale: "en" } },
      { id: "13", name: "expense_created", schemaVersion: "1.0.0", timestamp: "t13", properties: { split_mode: "exact", currency: "USD", member_count: 2 }, session: { id: "s2", locale: "en" } },

      // 4 payments started: 3 completed, 1 failed
      { id: "14", name: "payment_started", schemaVersion: "1.0.0", timestamp: "t14", properties: { asset: "XLM", is_partial: false }, session: { id: "s1", locale: "en" } },
      { id: "15", name: "payment_completed", schemaVersion: "1.0.0", timestamp: "t15", properties: { asset: "XLM", duration_ms: 1200 }, session: { id: "s1", locale: "en" } },
      { id: "16", name: "payment_started", schemaVersion: "1.0.0", timestamp: "t16", properties: { asset: "XLM", is_partial: false }, session: { id: "s1", locale: "en" } },
      { id: "17", name: "payment_completed", schemaVersion: "1.0.0", timestamp: "t17", properties: { asset: "XLM", duration_ms: 950 }, session: { id: "s1", locale: "en" } },
      { id: "18", name: "payment_started", schemaVersion: "1.0.0", timestamp: "t18", properties: { asset: "XLM", is_partial: false }, session: { id: "s2", locale: "en" } },
      { id: "19", name: "payment_completed", schemaVersion: "1.0.0", timestamp: "t19", properties: { asset: "XLM", duration_ms: 1100 }, session: { id: "s2", locale: "en" } },
      { id: "20", name: "payment_started", schemaVersion: "1.0.0", timestamp: "t20", properties: { asset: "XLM", is_partial: false }, session: { id: "s2", locale: "en" } },
      { id: "21", name: "payment_failed", schemaVersion: "1.0.0", timestamp: "t21", properties: { asset: "XLM", error_code: "OP_UNDERFUNDED" }, session: { id: "s2", locale: "en" } },
    ];

    const metrics = computeAggregateMetrics(sampleEvents);

    // 2 connected of 4 visitors = 50% activation
    expect(metrics.activationRate).toBe(50);
    // 2 expenses created of 2 started = 100%
    expect(metrics.expenseCompletionRate).toBe(100);
    // 3 payments completed of 4 = 75%
    expect(metrics.paymentCompletionRate).toBe(75);
    // Failures: 1 failed out of (4 payments + 2 wallet connects = 6 ops)
    expect(metrics.failuresByCode["OP_UNDERFUNDED"]).toBe(1);
    expect(metrics.redactionVerified).toBe(true);
  });

  it("flags redaction violation if an event in the stream contained sensitive data", () => {
    const leakedEvents: AnalyticsEvent[] = [
      {
        id: "leak-1",
        name: "wallet_connected",
        schemaVersion: "1.0.0",
        timestamp: "t",
        properties: {
          wallet_type: "freighter",
          network: "TESTNET",
          has_funds: true,
          // Accidental leak:
          leakedPubkey: "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV",
        } as any,
        session: { id: "s", locale: "en" },
      },
    ];

    const metrics = computeAggregateMetrics(leakedEvents);
    expect(metrics.redactionVerified).toBe(false);
  });
});
