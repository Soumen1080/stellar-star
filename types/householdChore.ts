export type HouseholdChoreCadence = "weekly" | "biweekly" | "monthly";

export interface HouseholdChore {
  id: string;
  tripId: string;
  title: string;
  details?: string;
  cadence: HouseholdChoreCadence;
  rotationWallets: string[];
  rotationCursor: number;
  nextDueOn: string;
  active: boolean;
  createdByWallet: string;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdChoreCompletion {
  id: string;
  choreId: string;
  tripId: string;
  completedByWallet: string;
  dueOn: string;
  supplyExpenseId?: string;
  completedAt: string;
}

export interface HouseholdChorePreference {
  tripId: string;
  walletAddress: string;
  optedOut: boolean;
}

export interface HouseholdChoreDraft {
  title: string;
  details?: string;
  cadence: HouseholdChoreCadence;
  rotationWallets: string[];
  nextDueOn: string;
}

export type HouseholdChoreRow = {
  id: string;
  trip_id: string;
  title: string;
  details: string | null;
  cadence: HouseholdChoreCadence;
  rotation_wallets: string[];
  rotation_cursor: number;
  next_due_on: string;
  active: boolean;
  created_by_wallet: string;
  created_at: string;
  updated_at: string;
}

export type HouseholdChoreCompletionRow = {
  id: string;
  chore_id: string;
  trip_id: string;
  completed_by_wallet: string;
  due_on: string;
  supply_expense_id: string | null;
  completed_at: string;
}

export type HouseholdChorePreferenceRow = {
  trip_id: string;
  wallet_address: string;
  opted_out: boolean;
  updated_at: string;
}
