import type { Expense, Member } from "./expense";

export interface Trip {
  id: string;
  name: string;
  description?: string;
  members: Member[];
  expenseIds: string[];
  createdAt: string;
  settled: boolean;
  createdByWallet?: string;
}

export type TripFormData = {
  name: string;
  description: string;
  members: Member[];
};
