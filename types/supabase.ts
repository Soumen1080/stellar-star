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
  id: string;
  title: string;
  description: string | null;
  total_amount: string;
  currency: string;
  split_mode: "equal" | "custom";
  paid_by_member_id: string;
  members: Json;
  shares: Json;
  settled: boolean;
  created_by_wallet: string;
  /** Derived by the `sync_member_wallets` trigger — read-only from the client. */
  member_wallets: string[];
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
};

export type SettlementIntentRow = {
  id: string;
  idempotency_key: string;
  trip_id: string;
  expense_id: string;
  member_id: string;
  payer_wallet: string;
  member_wallet: string;
  amount: string;
  currency: string;
  status: "pending" | "submitting" | "submitted" | "recorded" | "failed" | "cancelled";
  tx_hash: string | null;
  ledger: number | null;
  on_chain: boolean;
  error_message: string | null;
  created_by_wallet: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
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
        Insert: Omit<ExpenseRow, ServerManaged> & {
          id?: string;
          created_at?: string;
          currency?: string;
          settled?: boolean;
        };
        // `created_by_wallet` is absent by design: the database freezes it on
        // update, so an edit by one member cannot transfer ownership.
        Update: Partial<Omit<ExpenseRow, ServerManaged | "created_by_wallet">>;
        Relationships: [];
      };
      trips: {
        Row: TripRow;
        Insert: Omit<TripRow, ServerManaged> & {
          id?: string;
          created_at?: string;
          expense_ids?: string[];
          settled?: boolean;
        };
        Update: Partial<Omit<TripRow, ServerManaged | "created_by_wallet">>;
        Relationships: [];
      };
      settlement_intents: {
        Row: SettlementIntentRow;
        Insert: Omit<SettlementIntentRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          expires_at?: string;
          currency?: string;
          status?: SettlementIntentRow["status"];
          on_chain?: boolean;
          tx_hash?: string | null;
          ledger?: number | null;
          error_message?: string | null;
        };
        Update: Partial<Omit<SettlementIntentRow, "id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      current_wallet: {
        Args: Record<string, never>;
        Returns: string;
      };
      mark_share_paid: {
        Args: {
          p_expense_id: string;
          p_member_id: string;
          p_tx_hash: string;
          p_on_chain?: boolean;
        };
        Returns: ExpenseRow;
      };
      mark_shares_paid_batch: {
        Args: {
          p_updates: Json;
          p_tx_hash: string;
        };
        Returns: ExpenseRow[];
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
export type SettlementIntentInsert = Database["public"]["Tables"]["settlement_intents"]["Insert"];
export type SettlementIntentUpdate = Database["public"]["Tables"]["settlement_intents"]["Update"];

