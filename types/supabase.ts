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
  exchange_rate: string | null;
  exchange_rate_timestamp: string | null;
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
        // `created_by_wallet` and the amount/rate fields are absent by design:
        // the database freezes them on update.
        Update: Partial<Omit<ExpenseRow, ServerManaged | "created_by_wallet" | "total_amount" | "currency" | "exchange_rate" | "exchange_rate_timestamp">>;
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
    };
    Views: { [_ in never]: never };
    Functions: {
      current_wallet: {
        Args: Record<string, never>;
        Returns: string;
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
