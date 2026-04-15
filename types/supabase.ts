export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      expenses: {
        Row: {
          id: string;
          title: string;
          description: string | null;
          total_amount: string;
          currency: string;
          split_mode: string;
          paid_by_member_id: string;
          members: Json;
          shares: Json;
          created_at: string;
          updated_at: string;
          settled: boolean;
          created_by_wallet: string;
          member_wallets: string[];
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          total_amount: string;
          currency?: string;
          split_mode: string;
          paid_by_member_id: string;
          members: Json;
          shares: Json;
          created_at?: string;
          updated_at?: string;
          settled?: boolean;
          created_by_wallet: string;
          member_wallets?: string[];
        };
        Update: {
          id?: string;
          title?: string;
          description?: string | null;
          total_amount?: string;
          currency?: string;
          split_mode?: string;
          paid_by_member_id?: string;
          members?: Json;
          shares?: Json;
          created_at?: string;
          updated_at?: string;
          settled?: boolean;
          created_by_wallet?: string;
          member_wallets?: string[];
        };
      };
      trips: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          members: Json;
          expense_ids: string[];
          created_at: string;
          updated_at: string;
          settled: boolean;
          created_by_wallet: string;
          member_wallets: string[];
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          members: Json;
          expense_ids?: string[];
          created_at?: string;
          updated_at?: string;
          settled?: boolean;
          created_by_wallet: string;
          member_wallets?: string[];
        };
        Update: {
          id?: string;
          name?: string;
          description?: string | null;
          members?: Json;
          expense_ids?: string[];
          created_at?: string;
          updated_at?: string;
          settled?: boolean;
          created_by_wallet?: string;
          member_wallets?: string[];
        };
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
}
