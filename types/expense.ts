export type SplitMode = "equal" | "custom";

export interface Member {
  id: string;
  name: string;
  walletAddress?: string;
  weight?: number;
}

export interface SplitShare {
  memberId: string;
  name: string;
  walletAddress?: string;
  amount: string;
  paid: boolean;
  txHash?: string;
}

export interface Expense {
  id: string;
  title: string;
  description?: string;
  totalAmount: string;
  currency: "XLM";
  splitMode: SplitMode;
  paidByMemberId: string;
  members: Member[];
  shares: SplitShare[];
  createdAt: string;
  settled: boolean;
}

export type ExpenseFormData = {
  title: string;
  description: string;
  totalAmount: string;
  splitMode: SplitMode;
  paidByMemberId: string;
  members: Member[];
};
