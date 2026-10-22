/**
 * Shape of the `public` schema created by supabase-setup.sql.
 *
 * Kept hand-written (rather than generated) so it stays reviewable alongside
 * the SQL file. When you change supabase-setup.sql, change this too — the whole
 * data layer is typed through it.
 *
 * Everything here is a `type` alias rather than an `interface`: supabase-js
 * constrains the schema to `Record<string, GenericTable>`, and only type
 * aliases get the implicit index signature that satisfies it. An interface
 * silently resolves every query to `never`.
 */

import type {
  HouseholdChoreCompletionRow,
  HouseholdChorePreferenceRow,
  HouseholdChoreRow,
} from "./householdChore";

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/** Columns the database owns. Clients never send them on insert or update. */
type ServerManaged = "id" | "created_at" | "updated_at" | "member_wallets";

export type UserRow = {
  id: string;
  wallet_address: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  last_login_at: string;
};

export type ExpenseRow = {
  category?: string | null;
  tags?: string[];
  id: string;
  title: string;
  description: string | null;
  total_amount: string;
  currency: string;
  exchange_rate: string | null;
  exchange_rate_timestamp: string | null;
  /** Provenance columns from migration 0010; frozen after insert. */
  exchange_rate_source: string | null;
  entered_amount: string | null;
  settlement_asset: string;
  split_mode: "equal" | "custom";
  paid_by_member_id: string;
  members: Json;
  shares: Json;
  settled: boolean;
  version: number;
  created_by_wallet: string;
  /** Derived by the `sync_member_wallets` trigger — read-only from the client. */
  member_wallets: string[];
  created_at: string;
  updated_at: string;
  voided?: boolean;
  voided_at?: string | null;
  voided_by_wallet?: string | null;
  void_reason?: string | null;
  correction_of_expense_id?: string | null;
  correction_type?: 'reversal' | 'adjustment' | 'offset' | null;
  correction_reason?: string | null;
};

export type ExpenseAuditEventRow = {
  id: string;
  expense_id: string;
  action: 'voided' | 'correction_created' | 'reversal_created' | 'adjustment_created';
  actor_wallet: string;
  reason: string;
  metadata: Json;
  created_at: string;
};

export type TripRow = {
  id: string;
  name: string;
  description: string | null;
  members: Json;
  expense_ids: string[];
  settled: boolean;
  created_by_wallet: string;
  /** Derived by the `sync_member_wallets` trigger — read-only from the client. */
  member_wallets: string[];
  /** `date` columns (migration 0008); ISO YYYY-MM-DD strings. */
  starts_on: string | null;
  ends_on: string | null;
  recurring_rules: Json;
  permissions: Json;
  source_template_id: string | null;
  copied_from_trip_id: string | null;
  workspace?: Json | null;
  household_coordination_enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type TripTemplateRow = {
  id: string; owner_wallet: string; name: string; description: string | null;
  members: Json; recurring_rules: Json; permissions: Json; duration_days: number | null;
  source_trip_id: string | null; created_at: string; updated_at: string;
};
export type TripCopyEventRow = {
  id: string; idempotency_key: string; operation: "trip_to_template" | "template_to_trip" | "trip_to_trip";
  actor_wallet: string; source_kind: "template" | "trip"; source_id: string;
  target_kind: "template" | "trip"; target_id: string; summary: Json; created_at: string;
};
export type TripTemplateUpdate = Partial<Omit<TripTemplateRow, "id" | "owner_wallet" | "created_at" | "updated_at">>;
export type ContactRow = {
  id: string; owner_wallet: string; display_name: string; wallet_address: string | null;
  wallet_verified: boolean; claimed_by_wallet: string | null; verified_at: string | null;
  invite_destination: string | null; invite_channel: "email" | "phone" | "other" | null;
  claim_token_hash: string | null; claim_expires_at: string | null; created_at: string; updated_at: string;
};
export type ContactWalletChangeRow = {
  id: string; contact_id: string; owner_wallet: string; contact_name: string;
  old_wallet: string | null; new_wallet: string; status: "pending_notice" | "applied" | "cancelled";
  affected_trip_ids: string[]; notice_until: string; verified: boolean; created_at: string; applied_at: string | null;
};


export type PaymentReminderRow = {
  id: string;
  trip_id: string;
  expense_id: string;
  member_id: string;
  recipient_wallet: string;
  sender_wallet: string;
  amount: string;
  asset: string;
  note: string | null;
  trigger: "manual" | "schedule";
  schedule_id: string | null;
  state: "delivered" | "read" | "dismissed" | "cancelled" | "muted";
  channels: string[];
  created_at: string;
  updated_at: string;
  read_at: string | null;
};

export type ReminderEventRow = {
  id: string;
  reminder_id: string | null;
  actor_wallet: string;
  kind: string;
  channel: "in_app" | "email" | "push" | null;
  detail: string | null;
  created_at: string;
};

export type ReminderPreferencesRow = {
  wallet: string;
  email_opt_in: boolean;
  email_address: string | null;
  push_opt_in: boolean;
  push_endpoint: string | null;
  muted_trip_ids: string[];
  muted_sender_wallets: string[];
  created_at: string;
  updated_at: string;
};

export type ReminderScheduleRow = {
  id: string;
  trip_id: string;
  owner_wallet: string;
  interval_days: number;
  next_run_at: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};
export type ExportAuditEventRow = {
  id: string;
  actor_wallet: string;
  export_kind: "archive";
  status: "served" | "rate_limited" | "forbidden" | "failed";
  trip_ids: string[];
  trip_count: number;
  expense_count: number;
  byte_size: number;
  content_sha256: string | null;
  request_id: string | null;
  client_ip_hash: string | null;
  created_at: string;
};

export type SettlementProposalRow = {
  id: string;
  trip_id: string;
  creator_wallet: string;
  content_hash: string;
  snapshot: Json;
  status: "open" | "revoked" | "superseded" | "invalidated";
  expires_at: string;
  revoked_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SettlementProposalResponseRow = {
  id: string;
  proposal_id: string;
  member_id: string;
  wallet: string;
  decision: "approve" | "reject" | "request_edit";
  reason: string | null;
  content_hash: string;
  created_at: string;
};

export type ExpenseDisputeRow = {
  id: string; trip_id: string; expense_id: string; share_member_id: string;
  opened_by_wallet: string; category: "incorrect_amount" | "incorrect_split" | "not_shared" | "duplicate" | "already_paid" | "missing_context" | "other"; comment: string; evidence_receipt_ids: string[];
  status: "open" | "upheld" | "resolved"; created_at: string; resolved_at: string | null;
};

export type ExpenseDisputeEventRow = {
  id: string; dispute_id: string; actor_wallet: string;
  action: "opened" | "upheld" | "dismissed" | "adjusted";
  reason: string; created_at: string;
};

export type TripRoleAuditRow = {
  id: string;
  trip_id: string;
  member_id: string;
  previous_role: "owner" | "organizer" | "contributor" | "viewer" | "custom";
  next_role: "owner" | "organizer" | "contributor" | "viewer" | "custom";
  previous_custom_permissions: string[];
  next_custom_permissions: string[];
  changed_by_wallet: string;
  created_at: string;
};

export type AuthChallengeRow = {
  nonce: string;
  address: string;
  expiration: number;
  created_at: string;
};

export type AuthRateLimitRow = {
  key: string;
  count: number;
  window_start: number;
  updated_at: string;
};

export type TripInviteRow = {
  id: string;
  trip_id: string;
  token_hash: string;
  member_id: string | null;
  created_by_wallet: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked: boolean;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SettlementIntentRow = {
  id: string;
  idempotency_key: string;
  request_id: string;
  trip_id: string;
  expense_id: string;
  member_id: string;
  payer_wallet: string;
  member_wallet: string;
  amount: string;
  currency: string;
  status: "pending" | "submitting" | "submitted" | "recorded" | "failed" | "cancelled";
  tx_hash: string | null;
  /** `bigint` in Postgres; supabase-js returns it as a number. */
  ledger: number | null;
  on_chain: boolean;
  error_message: string | null;
  quote_metadata: Json | null;
  created_by_wallet: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type SettlementAttestationRow = {
  id: string;
  tx_hash: string;
  expense_id: string;
  member: string;
  /** `numeric(30)` — carried as a string so large values keep full precision. */
  amount_stroops: string;
  nonce: string;
  expires_at: number;
  signature: string;
  created_at: string;
};

export type ReconciliationJobRow = {
  id: string;
  intent_id: string | null;
  trip_id: string;
  expense_id: string;
  member_id: string;
  payer_wallet: string;
  member_wallet: string;
  asset: string;
  amount: string;
  amount_stroops: string;
  expected_memo: string | null;
  request_id: string | null;
  tx_hash: string | null;
  ledger: number | null;
  status: "not_submitted" | "submitted_not_confirmed" | "confirmed_not_recorded" | "recorded" | "escalated" | "failed";
  attempts: number;
  max_attempts: number;
  backoff_ms: number;
  last_attempt_at: string | null;
  next_attempt_at: string;
  escalation_reason: string | null;
  error_message: string | null;
  verified_at: string | null;
  recorded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeletedAccountRow = {
  wallet_address: string;
  deleted_at: string;
  reason: string;
};

export type SponsoredAccountRow = {
  account: string;
  /** `numeric(30)` — carried as a string so large values keep full precision. */
  locked_stroops: string;
  status: "active" | "revoked" | "reclaimed";
  created_at_ms: number;
  last_active_at_ms: number;
  sponsored_by: string;
  revoked_at_ms: number | null;
  created_at: string;
};

export type SponsorshipInviteRow = {
  id: string;
  inviter: string;
  invitee: string;
  created_at_ms: number;
  created_at: string;
};

export type ExpenseReceiptRow = {
  id: string;
  /** NULL once the expense is deleted; the retention sweep then purges the file. */
  expense_id: string | null;
  storage_path: string;
  file_name: string | null;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  caption: string | null;
  status: "active" | "quarantined" | "removed";
  scan_result: Json;
  uploaded_by_wallet: string;
  created_at: string;
  retain_until: string;
  removed_at: string | null;
  removed_by_wallet: string | null;
  removal_reason: "user" | "retention" | "expense_deleted" | null;
};

export type RecurringTemplateRow = {
  id: string;
  trip_id: string | null;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  currency: string;
  amount_kind: "fixed" | "variable";
  /** Fixed amount, or the pre-fill estimate for a variable one. */
  amount: string | null;
  split_mode: "equal" | "custom";
  paid_by_member_id: string;
  members: Json;
  cadence_unit: "day" | "week" | "month" | "year";
  cadence_interval: number;
  start_date: string;
  end_date: string | null;
  generate_from: string;
  reminder_lead_days: number | null;
  status: "active" | "paused" | "ended";
  version: number;
  created_by_wallet: string;
  /** Derived by the `sync_member_wallets` trigger — read-only from the client. */
  member_wallets: string[];
  created_at: string;
  updated_at: string;
};

export type RecurringExceptionRow = {
  id: string;
  template_id: string;
  occurrence_date: string;
  action: "skip" | "override";
  overrides: Json;
  created_by_wallet: string;
  created_at: string;
};

export type ExpenseDraftRow = {
  id: string;
  template_id: string;
  template_version: number;
  /** Copied from the template by trigger. */
  trip_id: string | null;
  occurrence_date: string;
  payload: Json;
  status: "pending" | "saved" | "dismissed";
  expense_id: string | null;
  /** Copied from the template by trigger — read-only from the client. */
  member_wallets: string[];
  created_at: string;
  resolved_at: string | null;
  resolved_by_wallet: string | null;
};

export type TripBudgetRow = {
  trip_id: string;
  currency: string;
  total_amount: string | null;
  category_caps: Json;
  thresholds: number[];
  version: number;
  created_by_wallet: string;
  created_at: string;
  updated_at: string;
};

export type BudgetAlertRow = {
  id: string;
  trip_id: string;
  scope: string;
  threshold: number;
  spent_at_crossing: string;
  fired_at: string;
  cleared_at: string | null;
};

export type BudgetAlertMuteRow = {
  trip_id: string;
  member_wallet: string;
  created_at: string;
};

export type SchemaMigrationRow = {
  version: string;
  name: string;
  applied_at: string;
  checksum: string;
};

export type SupportAuditLogRow = {
  id: string;
  staff_identifier: string;
  query_type: string;
  query_value: string;
  results_count: number;
  ip_address: string;
  user_agent: string | null;
  created_at: string;
};

export type SupportCorrectiveActionRow = {
  id: string;
  action_type: string;
  target_id: string;
  target_type: string;
  ticket_ref: string;
  reason: string;
  details: Json;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  status: "pending_approval" | "approved" | "executed" | "rejected" | "expired";
  execution_result: Json | null;
  created_at: string;
};

export type IdempotencyRecordRow = {
  key: string;
  wallet_address: string;
  endpoint: string;
  request_fingerprint: string;
  status: "pending" | "completed" | "failed";
  response_status: number | null;
  response_body: Json;
  created_at: string;
  locked_until: string;
};

export type Database = {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: {
          id?: string;
          wallet_address: string;
          display_name: string;
          created_at?: string;
          updated_at?: string;
          last_login_at?: string;
        };
        Update: {
          wallet_address?: string;
          display_name?: string;
          last_login_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      expenses: {
        Row: ExpenseRow;
        Insert: Omit<
          ExpenseRow,
          ServerManaged | "version" | "exchange_rate_source" | "entered_amount" | "settlement_asset"
        > & {
          id?: string;
          created_at?: string;
          currency?: string;
          settled?: boolean;
          version?: number;
          exchange_rate_source?: string | null;
          entered_amount?: string | null;
          settlement_asset?: string;
        };
        // `created_by_wallet` and the amount/rate/provenance fields are absent
        // by design: the database freezes them on update.
        Update: Partial<
          Omit<
            ExpenseRow,
            | ServerManaged
            | "created_by_wallet"
            | "total_amount"
            | "currency"
            | "exchange_rate"
            | "exchange_rate_timestamp"
            | "exchange_rate_source"
            | "entered_amount"
            | "settlement_asset"
          >
        >;
        Relationships: [];
      };
      trips: {
        Row: TripRow;
        // The structure columns from migration 0008 all have database defaults.
        Insert: Omit<
          TripRow,
          | ServerManaged
          | "starts_on"
          | "ends_on"
          | "recurring_rules"
          | "permissions"
          | "source_template_id"
          | "copied_from_trip_id"
          | "household_coordination_enabled"
        > & {
          id?: string;
          created_at?: string;
          expense_ids?: string[];
          settled?: boolean;
          starts_on?: string | null;
          ends_on?: string | null;
          recurring_rules?: Json;
          permissions?: Json;
          source_template_id?: string | null;
          copied_from_trip_id?: string | null;
          household_coordination_enabled?: boolean;
        };
        // Copy provenance is written once, by create_trip_from_copy.
        Update: Partial<
          Omit<TripRow, ServerManaged | "created_by_wallet" | "source_template_id" | "copied_from_trip_id">
        >;
        Relationships: [];
      };
      trip_role_audit: {
        Row: TripRoleAuditRow;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      household_chores: {
        Row: HouseholdChoreRow;
        Insert: Omit<HouseholdChoreRow, "id" | "rotation_cursor" | "active" | "created_at" | "updated_at"> & {
          id?: string;
          rotation_cursor?: number;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Pick<HouseholdChoreRow, "active">>;
        Relationships: [];
      };
      household_chore_completions: {
        Row: HouseholdChoreCompletionRow;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      household_chore_preferences: {
        Row: HouseholdChorePreferenceRow;
        Insert: Pick<HouseholdChorePreferenceRow, "trip_id" | "wallet_address"> &
          Partial<Pick<HouseholdChorePreferenceRow, "opted_out" | "updated_at">>;
        Update: Partial<Pick<HouseholdChorePreferenceRow, "opted_out" | "updated_at">>;
        Relationships: [];
      };
      trip_templates: {
        Row: TripTemplateRow;
        Insert: Omit<TripTemplateRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<TripTemplateRow, "id" | "owner_wallet" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      trip_copy_events: {
        Row: TripCopyEventRow;
        Insert: Omit<TripCopyEventRow, "id" | "created_at"> & { id?: string; created_at?: string };
        // Append-only: no UPDATE policy exists, so there is no update shape.
        Update: Record<string, never>;
        Relationships: [];
      };
      contacts: {
        Row: ContactRow;
        // Verification columns are set only by claim_contact_profile; the
        // guard trigger resets them on any direct write.
        Insert: Pick<ContactRow, "owner_wallet" | "display_name"> &
          Partial<
            Pick<
              ContactRow,
              "id" | "wallet_address" | "invite_destination" | "invite_channel" | "claim_token_hash" | "claim_expires_at"
            >
          >;
        Update: Partial<
          Pick<
            ContactRow,
            "display_name" | "wallet_address" | "invite_destination" | "invite_channel" | "claim_token_hash" | "claim_expires_at"
          >
        >;
        Relationships: [];
      };
      contact_wallet_changes: {
        Row: ContactWalletChangeRow;
        // Written only by the SECURITY DEFINER functions.
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      settlement_proposals: {
        Row: SettlementProposalRow;
        Insert: Pick<SettlementProposalRow, "trip_id" | "creator_wallet" | "content_hash" | "snapshot" | "expires_at"> &
          Partial<Pick<SettlementProposalRow, "status">>;
        // The snapshot is frozen by a trigger; only the lifecycle moves.
        Update: Partial<Pick<SettlementProposalRow, "status" | "revoked_reason">>;
        Relationships: [];
      };
      settlement_proposal_responses: {
        Row: SettlementProposalResponseRow;
        Insert: Omit<SettlementProposalResponseRow, "id" | "created_at">;
        // Append-only.
        Update: Record<string, never>;
        Relationships: [];
      };
      expense_audit_events: {
        Row: ExpenseAuditEventRow;
        Insert: Omit<ExpenseAuditEventRow, "id" | "created_at">;
        Update: Record<string, never>;
        Relationships: [];
      };
      expense_disputes: {
        Row: ExpenseDisputeRow;
        Insert: Pick<ExpenseDisputeRow, "trip_id" | "expense_id" | "share_member_id" | "opened_by_wallet" | "category" | "comment" | "evidence_receipt_ids">;
        Update: Partial<Pick<ExpenseDisputeRow, "status" | "resolved_at">>;
        Relationships: [];
      };
      expense_dispute_events: {
        Row: ExpenseDisputeEventRow;
        Insert: Omit<ExpenseDisputeEventRow, "id" | "created_at">;
        Update: Record<string, never>;
        Relationships: [];
      };

      payment_reminders: {
        Row: PaymentReminderRow;
        Insert: Omit<
          PaymentReminderRow,
          "id" | "state" | "created_at" | "updated_at" | "read_at"
        > &
          Partial<Omit<PaymentReminderRow, "id" | "created_at" | "updated_at">>;
        Update: Partial<Pick<PaymentReminderRow, "state" | "read_at" | "channels">>;
        Relationships: [];
      };
      reminder_events: {
        Row: ReminderEventRow;
        Insert: Omit<ReminderEventRow, "id" | "created_at">;
        Update: Record<string, never>;
        Relationships: [];
      };
      reminder_preferences: {
        Row: ReminderPreferencesRow;
        Insert: Pick<ReminderPreferencesRow, "wallet"> &
          Partial<Omit<ReminderPreferencesRow, "wallet" | "created_at" | "updated_at">>;
        Update: Partial<Omit<ReminderPreferencesRow, "wallet" | "created_at">>;
        Relationships: [];
      };
      reminder_schedules: {
        Row: ReminderScheduleRow;
        Insert: Pick<ReminderScheduleRow, "trip_id" | "owner_wallet" | "interval_days" | "next_run_at"> &
          Partial<Pick<ReminderScheduleRow, "active">>;
        Update: Partial<Pick<ReminderScheduleRow, "interval_days" | "next_run_at" | "active">>;
        Relationships: [];
      };
      export_audit_events: {
        Row: ExportAuditEventRow;
        Insert: Pick<ExportAuditEventRow, "actor_wallet" | "export_kind" | "status"> &
          Partial<Omit<ExportAuditEventRow, "id" | "created_at" | "actor_wallet" | "export_kind" | "status">>;
        // Append-only: no UPDATE policy exists.
        Update: Record<string, never>;
        Relationships: [];
      };
      trip_invites: {
        Row: TripInviteRow;
        Insert: {
          id?: string;
          trip_id: string;
          token_hash: string;
          member_id?: string | null;
          created_by_wallet: string;
          expires_at?: string;
          max_uses?: number;
          uses?: number;
          revoked?: boolean;
          revoked_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<TripInviteRow>;
        Relationships: [];
      };
      deleted_accounts: {
        Row: DeletedAccountRow;
        Insert: {
          wallet_address: string;
          deleted_at?: string;
          reason?: string;
        };
        Update: Partial<DeletedAccountRow>;
        Relationships: [];
      };
      reconciliation_queue: {
        Row: ReconciliationJobRow;
        Insert: {
          id?: string;
          intent_id?: string | null;
          trip_id: string;
          expense_id: string;
          member_id: string;
          payer_wallet: string;
          member_wallet: string;
          asset?: string;
          amount: string;
          amount_stroops: string;
          expected_memo?: string | null;
          request_id?: string | null;
          tx_hash?: string | null;
          ledger?: number | null;
          status?: "not_submitted" | "submitted_not_confirmed" | "confirmed_not_recorded" | "recorded" | "escalated" | "failed";
          attempts?: number;
          max_attempts?: number;
          backoff_ms?: number;
          last_attempt_at?: string | null;
          next_attempt_at?: string;
          escalation_reason?: string | null;
          error_message?: string | null;
          verified_at?: string | null;
          recorded_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ReconciliationJobRow, "id" | "created_at">>;
        Relationships: [];
      };
      settlement_intents: {
        Row: SettlementIntentRow;
        // Only the identifying/settlement fields are required. Everything the
        // database defaults (status, on_chain) or that is filled in later as the
        // transaction progresses (tx_hash, ledger, error_message) is optional.
        Insert: Pick<
          SettlementIntentRow,
          | "idempotency_key"
          | "request_id"
          | "trip_id"
          | "expense_id"
          | "member_id"
          | "payer_wallet"
          | "member_wallet"
          | "amount"
          | "created_by_wallet"
        > &
          Partial<Omit<SettlementIntentRow, "created_at" | "updated_at">> & {
            created_at?: string;
            updated_at?: string;
          };
        // `idempotency_key` is absent by design: it is the deduplication key,
        // so rewriting it would let one settlement be claimed twice.
        Update: Partial<Omit<SettlementIntentRow, "id" | "idempotency_key" | "created_at">>;
        Relationships: [];
      };
      settlement_attestations: {
        Row: SettlementAttestationRow;
        Insert: Omit<SettlementAttestationRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<SettlementAttestationRow, "id" | "created_at">>;
        Relationships: [];
      };
      sponsored_accounts: {
        Row: SponsoredAccountRow;
        Insert: Omit<SponsoredAccountRow, "status" | "revoked_at_ms" | "created_at"> & {
          status?: SponsoredAccountRow["status"];
          revoked_at_ms?: number | null;
          created_at?: string;
        };
        Update: Partial<Omit<SponsoredAccountRow, "account" | "created_at">>;
        Relationships: [];
      };
      sponsorship_invites: {
        Row: SponsorshipInviteRow;
        Insert: Omit<SponsorshipInviteRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<SponsorshipInviteRow, "id" | "created_at">>;
        Relationships: [];
      };
      expense_receipts: {
        Row: ExpenseReceiptRow;
        Insert: Omit<
          ExpenseReceiptRow,
          "id" | "created_at" | "status" | "scan_result" | "removed_at" | "removed_by_wallet" | "removal_reason"
        > & {
          id?: string;
          created_at?: string;
          status?: ExpenseReceiptRow["status"];
          scan_result?: Json;
        };
        // Only the lifecycle fields change after upload; the bytes, checksum
        // and uploader are fixed for the life of the row.
        Update: Partial<
          Pick<ExpenseReceiptRow, "status" | "file_name" | "caption" | "removed_at" | "removed_by_wallet" | "removal_reason">
        >;
        Relationships: [];
      };
      recurring_expense_templates: {
        Row: RecurringTemplateRow;
        Insert: Omit<
          RecurringTemplateRow,
          ServerManaged | "version" | "status" | "tags" | "generate_from"
        > & {
          id?: string;
          version?: number;
          status?: RecurringTemplateRow["status"];
          tags?: string[];
          generate_from?: string;
        };
        Update: Partial<Omit<RecurringTemplateRow, ServerManaged | "created_by_wallet" | "trip_id">>;
        Relationships: [];
      };
      recurring_expense_exceptions: {
        Row: RecurringExceptionRow;
        Insert: Omit<RecurringExceptionRow, "id" | "created_at" | "overrides"> & {
          id?: string;
          overrides?: Json;
        };
        Update: Partial<Pick<RecurringExceptionRow, "action" | "overrides">>;
        Relationships: [];
      };
      expense_drafts: {
        Row: ExpenseDraftRow;
        Insert: Pick<ExpenseDraftRow, "template_id" | "template_version" | "occurrence_date" | "payload"> & {
          id?: string;
        };
        // Only the resolution changes; the frozen payload and source never do.
        Update: Partial<Pick<ExpenseDraftRow, "status" | "expense_id" | "resolved_at" | "resolved_by_wallet">>;
        Relationships: [];
      };
      trip_budgets: {
        Row: TripBudgetRow;
        Insert: Omit<TripBudgetRow, "created_at" | "updated_at" | "version"> & { version?: number };
        Update: Partial<Omit<TripBudgetRow, "trip_id" | "created_at" | "updated_at" | "created_by_wallet">>;
        Relationships: [];
      };
      budget_alerts: {
        Row: BudgetAlertRow;
        Insert: Pick<BudgetAlertRow, "trip_id" | "scope" | "threshold" | "spent_at_crossing">;
        Update: Partial<Pick<BudgetAlertRow, "cleared_at">>;
        Relationships: [];
      };
      budget_alert_mutes: {
        Row: BudgetAlertMuteRow;
        Insert: Pick<BudgetAlertMuteRow, "trip_id" | "member_wallet">;
        Update: Record<string, never>;
        Relationships: [];
      };
      schema_migrations: {
        Row: SchemaMigrationRow;
        Insert: Omit<SchemaMigrationRow, "applied_at"> & { applied_at?: string };
        Update: Partial<Omit<SchemaMigrationRow, "version">>;
        Relationships: [];
      };
      idempotency_records: {
        Row: IdempotencyRecordRow;
        Insert: {
          key: string;
          wallet_address: string;
          endpoint: string;
          request_fingerprint: string;
          status: "pending" | "completed" | "failed";
          response_status?: number | null;
          response_body?: Json;
          created_at?: string;
          locked_until?: string;
        };
        Update: Partial<IdempotencyRecordRow>;
        Relationships: [];
      };
      auth_challenges: {
        Row: AuthChallengeRow;
        Insert: {
          nonce: string;
          address: string;
          expiration: number;
          created_at?: string;
        };
        Update: Partial<AuthChallengeRow>;
        Relationships: [];
      };

      support_audit_logs: {
        Row: SupportAuditLogRow;
        Insert: Omit<SupportAuditLogRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<SupportAuditLogRow>;
        Relationships: [];
      };
      support_corrective_actions: {
        Row: SupportCorrectiveActionRow;
        Insert: Omit<SupportCorrectiveActionRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<SupportCorrectiveActionRow>;
        Relationships: [];
      };
      auth_rate_limits: {
        Row: AuthRateLimitRow;
        Insert: {
          key: string;
          count?: number;
          window_start: number;
          updated_at?: string;
        };
        Update: Partial<AuthRateLimitRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      resolve_expense_dispute: {
        Args: { p_dispute_id: string; p_action: "upheld" | "dismissed" | "adjusted"; p_reason: string };
        Returns: undefined;
      };
      search_expenses: {
        Args: { p_trip_id: string | null; p_terms: string[] | null; p_category: string | null;
          p_tags: string[] | null; p_payer: string | null; p_status: string | null; p_asset: string | null;
          p_from: string | null; p_to: string | null; p_cursor_created_at: string | null; p_cursor_id: string | null; p_limit: number };
        Returns: ExpenseRow[];
      };
      complete_household_chore: {
        Args: { p_chore_id: string; p_due_on: string; p_supply_expense_id: string | null };
        Returns: string;
      };
      save_trip_template: {
        Args: { p_idempotency_key: string; p_source_trip_id: string; p_template: Json };
        Returns: TripTemplateRow[];
      };
      create_trip_from_copy: {
        Args: { p_idempotency_key: string; p_source_kind: string; p_source_id: string; p_trip: Json };
        Returns: TripRow[];
      };
      current_wallet: {
        Args: Record<string, never>;
        Returns: string;
      };
      trip_member_role: {
        Args: { p_trip_id: string; p_wallet: string };
        Returns: string;
      };
      trip_has_permission: {
        Args: { p_trip_id: string; p_permission: string };
        Returns: boolean;
      };
      expense_has_permission: {
        Args: { p_expense_id: string; p_permission: string };
        Returns: boolean;
      };
      set_trip_member_role: {
        Args: {
          p_trip_id: string;
          p_member_id: string;
          p_role: string;
          p_custom_permissions?: string[];
        };
        Returns: TripRow;
      };
      transfer_trip_ownership: {
        Args: { p_trip_id: string; p_new_owner_member_id: string };
        Returns: TripRow;
      };
      add_expense_to_trip: {
        Args: { p_trip_id: string; p_expense_id: string };
        Returns: string[];
      };
      consume_auth_challenge: {
        Args: {
          p_address: string;
          p_nonce: string;
          p_expiration: number;
          p_now: number;
        };
        Returns: boolean;
      };
      record_auth_challenge: {
        Args: {
          p_address: string;
          p_nonce: string;
          p_expiration: number;
          p_max_pending?: number;
        };
        Returns: boolean;
      };
      check_auth_rate_limit: {
        Args: {
          p_key: string;
          p_limit: number;
          p_window_ms: number;
          p_now: number;
        };
        Returns: Json;
      };
      claim_trip_invite: {
        Args: {
          p_token_hash: string;
          p_claiming_wallet: string;
          p_selected_member_id?: string;
          p_expected_trip_id?: string;
        };
        Returns: Json;
      };
      verify_trip_invite: {
        Args: {
          p_token_hash: string;
        };
        Returns: Json;
      };
      update_expense_versioned: {
        Args: {
          p_id: string;
          p_expected_version: number;
          p_title: string | null;
          p_description: string | null;
          p_total_amount: string | null;
          p_currency: string | null;
          p_split_mode: string | null;
          p_paid_by_member_id: string | null;
          p_members: Json | null;
          p_shares: Json | null;
          p_settled: boolean | null;
        };
        Returns: ExpenseRow[];
      };
      mark_share_paid: {
        Args: {
          p_expense_id: string;
          p_member_id: string;
          p_tx_hash: string;
          p_on_chain?: boolean;
        };
        Returns: ExpenseRow[];
      };
      mark_shares_paid_batch: {
        Args: {
          p_updates: Json;
          p_tx_hash: string;
        };
        Returns: ExpenseRow[];
      };
      void_expense: {
        Args: {
          p_expense_id: string;
          p_reason: string;
        };
        Returns: ExpenseRow[];
      };
      record_share_installment: {
        Args: {
          p_expense_id: string;
          p_member_id: string;
          p_installment: Json;
        };
        Returns: ExpenseRow[];
      };
      request_contact_wallet_change: {
        Args: { p_contact_id: string; p_new_wallet: string };
        Returns: ContactWalletChangeRow[];
      };
      apply_contact_wallet_change: {
        Args: { p_change_id: string };
        Returns: ContactRow[];
      };
      cancel_contact_wallet_change: {
        Args: { p_change_id: string };
        Returns: ContactWalletChangeRow[];
      };
      claim_contact_profile: {
        Args: { p_token_hash: string };
        Returns: Json;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type ExpenseInsert = Database["public"]["Tables"]["expenses"]["Insert"];
export type ExpenseUpdate = Database["public"]["Tables"]["expenses"]["Update"];
export type TripInsert = Database["public"]["Tables"]["trips"]["Insert"];
export type TripUpdate = Database["public"]["Tables"]["trips"]["Update"];
export type UserInsert = Database["public"]["Tables"]["users"]["Insert"];
export type UserUpdate = Database["public"]["Tables"]["users"]["Update"];
export type AuthChallengeInsert = Database["public"]["Tables"]["auth_challenges"]["Insert"];

export type SettlementIntentInsert = Database["public"]["Tables"]["settlement_intents"]["Insert"];
export type SettlementIntentUpdate = Database["public"]["Tables"]["settlement_intents"]["Update"];
export type ReconciliationJobInsert = Database["public"]["Tables"]["reconciliation_queue"]["Insert"];
export type ReconciliationJobUpdate = Database["public"]["Tables"]["reconciliation_queue"]["Update"];
export type SettlementAttestationInsert =
  Database["public"]["Tables"]["settlement_attestations"]["Insert"];
export type SponsoredAccountInsert = Database["public"]["Tables"]["sponsored_accounts"]["Insert"];
export type SponsoredAccountUpdate = Database["public"]["Tables"]["sponsored_accounts"]["Update"];
export type SponsorshipInviteInsert = Database["public"]["Tables"]["sponsorship_invites"]["Insert"];
export type TripInviteInsert = Database["public"]["Tables"]["trip_invites"]["Insert"];
export type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];
export type ContactUpdate = Database["public"]["Tables"]["contacts"]["Update"];
