export const ANALYTICS_SCHEMA_VERSION = "1.0.0";

export type ConsentStatus = "granted" | "denied" | "pending";
export type ConsentRegion = "strict" | "standard";

export interface ConsentSettings {
  status: ConsentStatus;
  analytics: boolean;
  timestamp: string;
  region: ConsentRegion;
}

/**
 * Public, non-sensitive product event names.
 * These measure activation, funnel progression, and friction without tracking users.
 */
export type AnalyticsEventName =
  // Activation / Onboarding Funnel
  | "app_loaded"
  | "wallet_connect_started"
  | "wallet_connected"
  | "wallet_connect_failed"
  | "onboarding_started"
  | "onboarding_completed"
  // Trip Funnel
  | "trip_create_started"
  | "trip_created"
  | "trip_viewed"
  // Expense Funnel
  | "expense_create_started"
  | "expense_created"
  // Payment / Settlement Funnel
  | "payment_started"
  | "payment_submitted"
  | "payment_completed"
  | "payment_failed";

export interface EventPropertiesMap {
  app_loaded: {
    locale: string;
    referrer_type?: "direct" | "internal" | "external";
  };
  wallet_connect_started: {
    wallet_type: "freighter" | "albedo" | "other" | "unknown";
  };
  wallet_connected: {
    wallet_type: string;
    network: string;
    has_funds: boolean;
  };
  wallet_connect_failed: {
    wallet_type: string;
    error_code: string;
  };
  onboarding_started: {
    step: number;
  };
  onboarding_completed: {
    step_count: number;
    duration_ms?: number;
  };
  trip_create_started: Record<string, never>;
  trip_created: {
    member_count: number;
    has_destination: boolean;
  };
  trip_viewed: {
    has_workspace: boolean;
    expense_count_tier: "0" | "1-5" | "6-20" | "20+";
  };
  expense_create_started: {
    currency: string;
  };
  expense_created: {
    split_mode: "equal" | "exact" | "percentage" | "shares" | string;
    currency: string;
    member_count: number;
  };
  payment_started: {
    asset: string;
    is_partial: boolean;
  };
  payment_submitted: {
    asset: string;
  };
  payment_completed: {
    asset: string;
    duration_ms?: number;
  };
  payment_failed: {
    asset: string;
    error_code: string;
  };
}

export interface AnalyticsEvent<TName extends AnalyticsEventName = AnalyticsEventName> {
  id: string;
  name: TName;
  schemaVersion: string;
  timestamp: string;
  properties: EventPropertiesMap[TName];
  session: {
    id: string;
    locale: string;
  };
}

export interface FunnelMetric {
  stage: string;
  count: number;
  rate: number; // percentage from initial stage
}

export interface AggregateMetrics {
  totalVisitors: number;
  walletConnections: number;
  tripsCreated: number;
  expensesCreated: number;
  paymentsCompleted: number;
  paymentsFailed: number;
  activationRate: number; // % of visitors who connected wallet and created/joined trip
  expenseCompletionRate: number; // % of started expenses that were created
  paymentCompletionRate: number; // % of started payments that completed
  failureRate: number; // % of payments that failed
  failuresByCode: Record<string, number>;
  walletConnectionsByType: Record<string, number>;
  expensesByCurrency: Record<string, number>;
  redactionVerified: boolean;
}
