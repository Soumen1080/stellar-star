export interface ContractPaymentRecord {
  tripId: string;
  expenseId: string;
  payer: string;
  member: string;
  amountStroops: bigint;
  txHash: string;
  timestamp: number;
}

// Contract call status

export type ContractCallStatus =
  | { status: "idle" }
  | { status: "simulating" }
  | { status: "signing" }
  | { status: "sending" }
  | { status: "confirming" }
  | { status: "success"; ledger: number }
  | { status: "error"; message: string; code?: number };

export enum ContractErrorCode {
  InvalidAmount = 1,
  AlreadyPaid   = 2,
  EmptyId       = 3,
  AlreadyInitialized = 4,
  NotInitialized = 5,
  InvalidActor = 6,
  IdTooLong = 7,
  AmountTooLarge = 8,
  VersionMismatch = 9,
  TxHashTooLong = 10,
}

export interface ContractPaymentEvent {
  ledger: number;
  ledgerClosedAt: string;
  tripId: string;
  expenseId: string;
  member: string;
  amountStroops: string;
  txHash: string;
}

export interface GetPaymentsResult {
  payments: ContractPaymentRecord[];
  success: boolean;
  error?: string;
}

export interface IsPaidResult {
  paid: boolean;
  success: boolean;
  error?: string;
}
