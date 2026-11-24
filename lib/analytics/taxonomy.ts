import {
  type AnalyticsEventName,
  ANALYTICS_SCHEMA_VERSION,
} from "./types";

export interface TaxonomyEventDef {
  name: AnalyticsEventName;
  stage: "activation" | "trip" | "expense" | "settlement";
  description: string;
  allowedProperties: string[];
  strictlyForbidden: string[];
  rationale: string;
}

export const EVENT_TAXONOMY: Record<AnalyticsEventName, TaxonomyEventDef> = {
  app_loaded: {
    name: "app_loaded",
    stage: "activation",
    description: "Emitted when a user initializes the application interface.",
    allowedProperties: ["locale", "referrer_type"],
    strictlyForbidden: ["ip_address", "user_agent", "device_fingerprint"],
    rationale: "Measures top-of-funnel traffic and locale distribution.",
  },
  wallet_connect_started: {
    name: "wallet_connect_started",
    stage: "activation",
    description: "Emitted when a user clicks to connect a wallet.",
    allowedProperties: ["wallet_type"],
    strictlyForbidden: ["publicKey", "walletAddress", "accountId"],
    rationale: "Identifies initial intent to engage with Web3 features.",
  },
  wallet_connected: {
    name: "wallet_connected",
    stage: "activation",
    description: "Emitted when a wallet connection succeeds.",
    allowedProperties: ["wallet_type", "network", "has_funds"],
    strictlyForbidden: ["publicKey", "walletAddress", "secretKey", "balance_exact"],
    rationale: "Measures wallet provider distribution and funding readiness.",
  },
  wallet_connect_failed: {
    name: "wallet_connect_failed",
    stage: "activation",
    description: "Emitted when a wallet connection request fails or is rejected.",
    allowedProperties: ["wallet_type", "error_code"],
    strictlyForbidden: ["publicKey", "walletAddress", "stack_trace_pii"],
    rationale: "Prioritizes wallet support fixes and extension compatibility issues.",
  },
  onboarding_started: {
    name: "onboarding_started",
    stage: "activation",
    description: "Emitted when a user begins the introductory walkthrough.",
    allowedProperties: ["step", "mode"],
    strictlyForbidden: ["email", "user_id", "walletAddress", "publicKey", "description", "memo"],
    rationale: "Identifies step-by-step onboarding drop-off points.",
  },
  onboarding_step_completed: {
    name: "onboarding_step_completed",
    stage: "activation",
    description: "Emitted when an onboarding step is completed.",
    allowedProperties: ["mode", "step_index", "step_name"],
    strictlyForbidden: ["walletAddress", "publicKey", "memo", "trip_id"],
    rationale: "Measures progressive completion across onboarding flows.",
  },
  onboarding_completed: {
    name: "onboarding_completed",
    stage: "activation",
    description: "Emitted when the onboarding walkthrough finishes.",
    allowedProperties: ["step_count", "duration_ms", "mode"],
    strictlyForbidden: ["user_id", "walletAddress", "publicKey"],
    rationale: "Measures overall activation success rate.",
  },
  onboarding_abandoned: {
    name: "onboarding_abandoned",
    stage: "activation",
    description: "Emitted when an onboarding walkthrough is dismissed or abandoned.",
    allowedProperties: ["mode", "last_step_index"],
    strictlyForbidden: ["walletAddress", "publicKey", "memo"],
    rationale: "Measures where users drop off in onboarding.",
  },
  first_settlement_checklist_started: {
    name: "first_settlement_checklist_started",
    stage: "settlement",
    description: "Emitted when a user opens or starts the first-settlement checklist.",
    allowedProperties: ["context"],
    strictlyForbidden: ["walletAddress", "publicKey", "amount", "memo"],
    rationale: "Measures readiness checks before payment submission.",
  },
  first_settlement_checklist_step_completed: {
    name: "first_settlement_checklist_step_completed",
    stage: "settlement",
    description: "Emitted when a user completes or clears a settlement checklist item.",
    allowedProperties: ["step_key", "step_index"],
    strictlyForbidden: ["walletAddress", "publicKey", "secretKey", "amount", "memo"],
    rationale: "Measures resolution of prerequisites before settlement.",
  },
  first_settlement_checklist_completed: {
    name: "first_settlement_checklist_completed",
    stage: "settlement",
    description: "Emitted when all checklist prerequisites are confirmed.",
    allowedProperties: ["duration_ms"],
    strictlyForbidden: ["walletAddress", "publicKey", "amount"],
    rationale: "Measures settlement readiness success.",
  },
  first_settlement_checklist_abandoned: {
    name: "first_settlement_checklist_abandoned",
    stage: "settlement",
    description: "Emitted when a user exits or dismisses the checklist with incomplete items.",
    allowedProperties: ["last_step_key", "incomplete_steps_count"],
    strictlyForbidden: ["walletAddress", "publicKey", "amount", "memo"],
    rationale: "Identifies remaining hurdles before successful settlement.",
  },
  trip_create_started: {
    name: "trip_create_started",
    stage: "trip",
    description: "Emitted when the trip creation dialog is opened.",
    allowedProperties: [],
    strictlyForbidden: ["trip_title", "destination", "dates", "member_names"],
    rationale: "Tracks trip creation initiation.",
  },
  trip_created: {
    name: "trip_created",
    stage: "trip",
    description: "Emitted when a new group trip is successfully saved.",
    allowedProperties: ["member_count", "has_destination", "has_dates", "has_recurring_rules"],
    strictlyForbidden: ["title", "description", "destination", "walletAddress", "member_names"],
    rationale: "Measures core group formation and trip size distribution.",
  },
  trip_viewed: {
    name: "trip_viewed",
    stage: "trip",
    description: "Emitted when navigating to an active trip workspace.",
    allowedProperties: ["has_workspace", "expense_count_tier"],
    strictlyForbidden: ["trip_id", "title", "itinerary_text", "booking_links"],
    rationale: "Tracks trip workspace engagement and feature adoption.",
  },
  expense_create_started: {
    name: "expense_create_started",
    stage: "expense",
    description: "Emitted when opening the new expense form.",
    allowedProperties: ["currency"],
    strictlyForbidden: ["title", "description", "amount", "notes"],
    rationale: "Identifies currency preferences and intent to record expenses.",
  },
  expense_created: {
    name: "expense_created",
    stage: "expense",
    description: "Emitted when an expense is split and saved.",
    allowedProperties: ["split_mode", "currency", "member_count", "attachment_present"],
    strictlyForbidden: ["title", "description", "amount", "receipt_file", "ocr_data", "walletAddress"],
    rationale: "Measures bill-splitting completion and preferred split methods.",
  },
  payment_started: {
    name: "payment_started",
    stage: "settlement",
    description: "Emitted when a settlement payment flow is initiated.",
    allowedProperties: ["asset", "is_partial", "currency", "on_chain"],
    strictlyForbidden: ["amount", "exact_amount", "from_wallet", "to_wallet", "memo"],
    rationale: "Tracks settlement initiation without financial surveillance.",
  },
  payment_submitted: {
    name: "payment_submitted",
    stage: "settlement",
    description: "Emitted when the transaction is signed and broadcast.",
    allowedProperties: ["asset"],
    strictlyForbidden: ["tx_hash", "xdr", "signed_envelope", "signatures"],
    rationale: "Measures network broadcast attempts.",
  },
  payment_completed: {
    name: "payment_completed",
    stage: "settlement",
    description: "Emitted when Horizon or Soroban confirms the transaction.",
    allowedProperties: ["asset", "duration_ms", "currency", "on_chain"],
    strictlyForbidden: ["tx_hash", "xdr", "claim_id", "from_wallet", "to_wallet", "amount"],
    rationale: "Measures settlement completion rate and confirmation latency.",
  },
  payment_failed: {
    name: "payment_failed",
    stage: "settlement",
    description: "Emitted when a payment fails or is rejected.",
    allowedProperties: ["asset", "error_code", "currency", "on_chain"],
    strictlyForbidden: ["tx_hash", "xdr", "walletAddress", "private_key", "error_details_pii"],
    rationale: "Prioritizes settlement friction, e.g. out-of-gas or insufficient funds.",
  },
};

export const ALLOWED_EVENT_NAMES = Object.keys(EVENT_TAXONOMY) as AnalyticsEventName[];

export function isAllowedEventName(name: string): name is AnalyticsEventName {
  return (ALLOWED_EVENT_NAMES as string[]).includes(name);
}

export function getEventDefinition(name: AnalyticsEventName): TaxonomyEventDef {
  return EVENT_TAXONOMY[name];
}
