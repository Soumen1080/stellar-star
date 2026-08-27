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
  AttestationExpired = 11,
  AttestationReplayed = 12,
  AttestationTtlTooLong = 13,
  AssetMismatch = 14,
  UnknownStorageVersion = 15,
}

/**
 * Settlement pool error codes.
 *
 * A separate enum from `ContractErrorCode`: the two contracts number their
 * errors independently, so code 5 means `NotInitialized` in one and
 * `InsufficientBalance` in the other. Decoding a pool error with the
 * settlement table would produce a confidently wrong message.
 */
export enum PoolErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  Unauthorized = 3,
  InvalidAmount = 4,
  InsufficientBalance = 5,
  BalanceOverflow = 6,
  VersionMismatch = 7,
  InvalidActor = 8,
  AmountTooLarge = 9,
  UnsupportedAsset = 10,
  UnknownStorageVersion = 11,
  TooManyAssets = 12,
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
