import {
  Contract,
  TransactionBuilder,
  Account,
  rpc,
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
} from "@stellar/stellar-sdk";
import type { Attestation } from "@/lib/settlement/attest";
import { sorobanServer } from "./soroban";
import { signXDR } from "@/lib/freighter";
import {
  HORIZON_URL,
  SOROBAN_RPC_URL,
  CONTRACT_ID,
  SETTLEMENT_ASSET_ID,
  NETWORK_PASSPHRASE,
  APP_NAME,
} from "@/lib/utils/constants";
import { Money } from "@/lib/money";
import { getSuggestedBaseFee } from "@/lib/stellar/fees";
import { reportError } from "@/lib/observability/reportError";
import type {
  ContractPaymentRecord,
  GetPaymentsResult,
  IsPaidResult,
} from "@/types/contract";
import { ContractErrorCode, PoolErrorCode } from "@/types/contract";

const SOROBAN_BASE_FEE  = "1000";
const MAX_POLL_ATTEMPTS  = 20;
const POLL_INTERVAL_MS   = 2500;

export function decodeContractError(raw: string): string {
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match) {
    const code = Number(match[1]);
    switch (code) {
      case ContractErrorCode.InvalidAmount:
        return "Payment amount must be greater than zero.";
      case ContractErrorCode.AlreadyPaid:
        return "This expense was already settled on-chain. No double payment needed.";
      case ContractErrorCode.EmptyId:
        return "Trip ID or expense ID is missing - cannot record payment.";
      case ContractErrorCode.AlreadyInitialized:
        return "Contract is already initialized.";
      case ContractErrorCode.NotInitialized:
        return "Contract is not initialized yet.";
      case ContractErrorCode.InvalidActor:
        return "Invalid actor for this operation.";
      case ContractErrorCode.IdTooLong:
        return "Trip ID or expense ID is too long.";
      case ContractErrorCode.AmountTooLarge:
        return "Amount is above the allowed limit.";
      case ContractErrorCode.VersionMismatch:
        return "Contract storage version mismatch.";
      case ContractErrorCode.TxHashTooLong:
        return "Transaction hash is too long.";
      case ContractErrorCode.AttestationExpired:
        return "The settlement attestation expired before it was submitted. Retry to get a fresh one.";
      case ContractErrorCode.AttestationReplayed:
        return "This settlement attestation was already used. Retry to get a fresh one.";
      case ContractErrorCode.AttestationTtlTooLong:
        return "The settlement attestation's validity window is longer than the contract allows.";
      case ContractErrorCode.AssetMismatch:
        return "The attestation is for a different asset than this contract settles in.";
      case ContractErrorCode.UnknownStorageVersion:
        return "The contract's stored data is newer than this app understands. Update the app.";
      default:
        return `Contract error #${code}.`;
    }
  }
  return raw;
}

/**
 * Decodes an error raised by the *pool* contract.
 *
 * Kept separate from `decodeContractError` because the two contracts number
 * their errors independently — code 5 is `NotInitialized` in the settlement
 * contract and `InsufficientBalance` in the pool — so using one table for both
 * yields a confidently wrong message rather than an unhelpful one.
 */
export function decodePoolError(raw: string): string {
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!match) return raw;

  switch (Number(match[1])) {
    case PoolErrorCode.InvalidAmount:
      return "Pool amount must be greater than zero.";
    case PoolErrorCode.InsufficientBalance:
      return "Not enough pool credit in this asset.";
    case PoolErrorCode.NotInitialized:
      return "The settlement pool is not initialized yet.";
    case PoolErrorCode.UnsupportedAsset:
      return "This asset is not accepted by the settlement pool.";
    case PoolErrorCode.UnknownStorageVersion:
      return "The pool's stored data is newer than this app understands. Update the app.";
    case PoolErrorCode.TooManyAssets:
      return "The settlement pool is at its supported-asset limit.";
    case PoolErrorCode.AmountTooLarge:
      return "Amount is above the pool's allowed limit.";
    case PoolErrorCode.BalanceOverflow:
      return "Pool balance would overflow.";
    default:
      return `Pool contract error #${match[1]}.`;
  }
}

async function loadAccount(
  publicKey: string,
  fallbackSequence?: string,
): Promise<Account> {
  const res = await fetch(
    `${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`,
    { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
  );
  if (res.status === 404 && fallbackSequence !== undefined) {
    return new Account(publicKey, fallbackSequence);
  }
  if (!res.ok) {
    throw new Error(
      `Failed to load Stellar account (${res.status}). Verify your address is funded on testnet.`
    );
  }
  const data = (await res.json()) as { sequence: string };
  return new Account(publicKey, data.sequence);
}

/**
 * Resolves a transaction source for read-only Soroban simulations.
 * Unfunded accounts are not on Horizon (404); use sequence "0" so status queries still work.
 */
async function accountForReadOnlySimulation(publicKey: string): Promise<Account> {
  return loadAccount(publicKey, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Submit an assembled, signed Soroban transaction and poll until confirmed.
 * Shared by `depositPoolBalance` and `recordPaymentOnChain` to avoid duplication.
 */
async function submitAndPoll(
  signedXdr: string,
  onStatus?: (step: "simulating" | "signing" | "sending" | "confirming") => void,
): Promise<{ ledger: number }> {
  onStatus?.("sending");
  const sendResult = await sorobanServer.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  );

  if (sendResult.status === "ERROR") {
    throw new Error(
      `Contract send failed: ${
        sendResult.errorResult?.result()?.toXDR("base64") ?? "unknown error"
      }`,
    );
  }

  onStatus?.("confirming");
  const txHash = sendResult.hash;

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollResult = await sorobanServer.getTransaction(txHash);

    if (pollResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { ledger: (pollResult as { ledger: number }).ledger };
    }
    if (pollResult.status === rpc.Api.GetTransactionStatus.FAILED) {
      const failedResult = pollResult as { resultXdr?: { toXDR?: () => unknown } };
      const rawMsg = failedResult.resultXdr
        ? `Contract error: ${String(failedResult.resultXdr)}`
        : "Contract transaction was submitted but failed on-chain.";
      throw new Error(decodeContractError(rawMsg));
    }
  }

  throw new Error("Contract transaction timed out waiting for confirmation.");
}

function xlmToStroops(xlm: string): bigint {
  return Money.parse(xlm).toStroops();
}

export function stroopsToXlm(stroops: bigint | string): string {
  return Money.fromStroops(stroops).format(7);
}

function contractReady(caller: string): boolean {
  if (!CONTRACT_ID) {
    console.info(
      `[StellarStar] ${caller}: CONTRACT_ID not set - skipping on-chain step. ` +
      "Deploy the contract and add NEXT_PUBLIC_CONTRACT_ID to .env.local."
    );
    return false;
  }
  return true;
}

/**
 * Encodes an `Attestation` as the contract's `#[contracttype]` struct.
 *
 * Soroban represents such a struct as an `ScMap` keyed by field-name symbols,
 * and the host requires those keys in sorted order — hence the field ordering
 * below (asset, expires_at, nonce, signature), which is alphabetical rather
 * than the declaration order in `attest.rs`.
 */
function attestationToScVal(attestation: Attestation): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

  return xdr.ScVal.scvMap([
    entry("asset", new Address(attestation.claim.asset).toScVal()),
    entry("expires_at", nativeToScVal(BigInt(attestation.claim.expiresAt), { type: "u64" })),
    entry("nonce", xdr.ScVal.scvBytes(Buffer.from(attestation.claim.nonce, "hex"))),
    entry("signature", xdr.ScVal.scvBytes(Buffer.from(attestation.signature, "hex"))),
  ]);
}

export interface RecordPaymentParams {
  memberPublicKey: string;
  tripId: string;
  expenseId: string;
  payerPublicKey: string;
  amountXlm: string;
  txHash: string;
  /**
   * Oracle attestation for this exact claim. Required — the contract rejects
   * any `record_payment` without one, which is the point of the whole seam.
   */
  attestation: Attestation;
  onStatus?: (step: "simulating" | "signing" | "sending" | "confirming") => void;
}

export interface RecordPaymentResult {
  success: boolean;
  ledger?: number;
  error?: string;
}

export interface PoolPrecheckResult {
  ok: boolean;
  requiredStroops: bigint;
  balanceStroops?: bigint;
  shortfallStroops?: bigint;
  error?: string;
}

async function getPoolContractId(callerPublicKey: string): Promise<string> {
  const account = await loadAccount(callerPublicKey);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_pool_contract"))
    .setTimeout(30)
    .build();

  const simResult = await sorobanServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(decodeContractError(simResult.error));
  }
  if (!rpc.Api.isSimulationSuccess(simResult) || !simResult.result?.retval) {
    throw new Error("Unable to read settlement pool contract.");
  }

  const native = scValToNative(simResult.result.retval) as unknown;
  if (typeof native !== "string" || native.length === 0) {
    throw new Error("Invalid pool contract id returned by settlement contract.");
  }
  return native;
}

/**
 * Reads a member's pool credit in one asset.
 *
 * The pool is keyed by `(member, token)` as of #145, so a balance read has to
 * name its asset — asking for "the" balance is the ambiguity that let a
 * settlement in one asset debit another. `assetId` defaults to this
 * deployment's settlement asset; passing nothing falls back to the pool's own
 * `balance_of`, which resolves the default on-chain.
 */
export async function getPoolBalanceStroops(
  callerPublicKey: string,
  memberPublicKey: string,
  assetId: string = SETTLEMENT_ASSET_ID,
): Promise<bigint> {
  const account = await loadAccount(callerPublicKey);
  const poolContractId = await getPoolContractId(callerPublicKey);
  const poolContract = new Contract(poolContractId);

  const call = assetId
    ? poolContract.call(
        "balance_of_asset",
        new Address(memberPublicKey).toScVal(),
        new Address(assetId).toScVal(),
      )
    : poolContract.call("balance_of", new Address(memberPublicKey).toScVal());

  const tx = new TransactionBuilder(account, {
    fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(call)
    .setTimeout(30)
    .build();

  const simResult = await sorobanServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(decodePoolError(simResult.error));
  }
  if (!rpc.Api.isSimulationSuccess(simResult) || !simResult.result?.retval) {
    throw new Error("Unable to read member pool balance.");
  }

  const native = scValToNative(simResult.result.retval) as bigint | string | number;
  return BigInt(native);
}

export async function precheckPoolBalance(
  callerPublicKey: string,
  memberPublicKey: string,
  amountXlm: string,
  assetId: string = SETTLEMENT_ASSET_ID,
): Promise<PoolPrecheckResult> {
  const requiredStroops = xlmToStroops(amountXlm);

  if (!contractReady("precheckPoolBalance")) {
    return { ok: false, requiredStroops, error: "Contract not configured." };
  }

  try {
    const balanceStroops = await getPoolBalanceStroops(
      callerPublicKey,
      memberPublicKey,
      assetId,
    );
    if (balanceStroops >= requiredStroops) {
      return { ok: true, requiredStroops, balanceStroops };
    }

    return {
      ok: false,
      requiredStroops,
      balanceStroops,
      shortfallStroops: requiredStroops - balanceStroops,
      error:
        `Pool balance too low. Required ${stroopsToXlm(requiredStroops)} XLM, ` +
        `available ${stroopsToXlm(balanceStroops)} XLM.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pool precheck failed.";
    return { ok: false, requiredStroops, error: message };
  }
}

export interface DepositPoolResult {
  success: boolean;
  ledger?: number;
  error?: string;
}

export async function depositPoolBalance(
  memberPublicKey: string,
  amountXlm: string,
  onStatus?: (step: "simulating" | "signing" | "sending" | "confirming") => void,
  assetId: string = SETTLEMENT_ASSET_ID,
): Promise<DepositPoolResult> {
  if (!contractReady("depositPoolBalance")) {
    return { success: false, error: "Contract not configured." };
  }

  try {
    const account = await loadAccount(memberPublicKey);
    const poolContractId = await getPoolContractId(memberPublicKey);
    const poolContract = new Contract(poolContractId);

    const amountStroops = xlmToStroops(amountXlm);

    // Name the asset explicitly where we know it: crediting the pool's default
    // when the caller meant something else is the same class of bug as
    // debiting it.
    const call = assetId
      ? poolContract.call(
          "deposit_asset",
          new Address(memberPublicKey).toScVal(),
          new Address(assetId).toScVal(),
          nativeToScVal(amountStroops, { type: "i128" }),
        )
      : poolContract.call(
          "deposit",
          new Address(memberPublicKey).toScVal(),
          nativeToScVal(amountStroops, { type: "i128" }),
        );

    const tx = new TransactionBuilder(account, {
      fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(call)
      .setTimeout(60)
      .build();

    onStatus?.("simulating");
    const simResult = await sorobanServer.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(decodePoolError(simResult.error));
    }
    if (!rpc.Api.isSimulationSuccess(simResult)) {
      throw new Error("Contract simulation returned an unexpected result.");
    }

    const assembled = rpc.assembleTransaction(tx, simResult).build();

    onStatus?.("signing");
    const signedXdr = await signXDR(assembled.toXDR(), NETWORK_PASSPHRASE);

    const { ledger } = await submitAndPoll(signedXdr, onStatus);
    return { success: true, ledger };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deposit failed.";
    return { success: false, error: message };
  }
}

export async function recordPaymentOnChain(
  params: RecordPaymentParams
): Promise<RecordPaymentResult> {
  if (!contractReady("recordPaymentOnChain")) {
    return { success: false, error: "Contract not configured." };
  }

  const {
    memberPublicKey,
    tripId,
    expenseId,
    payerPublicKey,
    amountXlm,
    txHash,
    attestation,
    onStatus,
  } = params;

  try {
    const account  = await loadAccount(memberPublicKey);
    const contract = new Contract(CONTRACT_ID);

    const amountStroops = xlmToStroops(amountXlm);

    // The attestation covers these exact values. Submitting anything else
    // produces a claim the oracle never signed, so the contract would reject
    // it — better to catch the mismatch here than to spend a fee proving it.
    if (BigInt(attestation.claim.amountStroops) !== amountStroops) {
      throw new Error("Attestation amount does not match the payment being recorded.");
    }

    const contractArgs = [
      nativeToScVal(tripId,           { type: "string" }),
      nativeToScVal(expenseId,        { type: "string" }),
      new Address(payerPublicKey).toScVal(),
      new Address(memberPublicKey).toScVal(),
      nativeToScVal(amountStroops,    { type: "i128" }),
      nativeToScVal(txHash,           { type: "string" }),
      attestationToScVal(attestation),
    ];

    const tx = new TransactionBuilder(account, {
      fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("record_payment", ...contractArgs))
      .setTimeout(60)
      .build();

    onStatus?.("simulating");
    const simResult = await sorobanServer.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(decodeContractError(simResult.error));
    }
    if (!rpc.Api.isSimulationSuccess(simResult)) {
      throw new Error("Contract simulation returned an unexpected result.");
    }

    const assembled = rpc.assembleTransaction(tx, simResult).build();

    onStatus?.("signing");
    const signedXdr = await signXDR(assembled.toXDR(), NETWORK_PASSPHRASE);

    const { ledger } = await submitAndPoll(signedXdr, onStatus);
    return { success: true, ledger };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Contract call failed.";
    reportError("contract.recordPaymentOnChain", err, { message });
    return { success: false, error: message };
  }
}

export interface NetSettlementDebt {
  expenseId: string;
  amountXlm: string;
  /**
   * Attestation for this individual debt. A net settlement is one payment
   * covering several expenses, and the contract records each one separately,
   * so each needs its own single-use attestation. The oracle's allocation
   * ledger is what stops their total exceeding the payment.
   */
  attestation: Attestation;
}

export interface RecordNetSettlementParams {
  memberPublicKey: string;
  tripId: string;
  payerPublicKey: string;
  txHash: string;
  debts: NetSettlementDebt[];
  onStatus?: (step: "simulating" | "signing" | "sending" | "confirming") => void;
}

export async function recordNetSettlementOnChain(
  params: RecordNetSettlementParams
): Promise<RecordPaymentResult> {
  if (!contractReady("recordNetSettlementOnChain")) {
    return { success: false, error: "Contract not configured." };
  }

  const {
    memberPublicKey,
    tripId,
    payerPublicKey,
    txHash,
    debts,
    onStatus,
  } = params;

  try {
    const account  = await loadAccount(memberPublicKey);
    const contract = new Contract(CONTRACT_ID);

    let txBuilder = new TransactionBuilder(account, {
      fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    for (const debt of debts) {
      const amountStroops = xlmToStroops(debt.amountXlm);
      if (BigInt(debt.attestation.claim.amountStroops) !== amountStroops) {
        throw new Error(
          `Attestation amount does not match the debt being recorded for expense ${debt.expenseId}.`,
        );
      }

      const contractArgs = [
        nativeToScVal(tripId,           { type: "string" }),
        nativeToScVal(debt.expenseId,   { type: "string" }),
        new Address(payerPublicKey).toScVal(),
        new Address(memberPublicKey).toScVal(),
        nativeToScVal(amountStroops,    { type: "i128" }),
        nativeToScVal(txHash,           { type: "string" }),
        attestationToScVal(debt.attestation),
      ];
      txBuilder = txBuilder.addOperation(contract.call("record_payment", ...contractArgs));
    }

    const tx = txBuilder.setTimeout(60).build();

    onStatus?.("simulating");
    const simResult = await sorobanServer.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(decodeContractError(simResult.error));
    }
    if (!rpc.Api.isSimulationSuccess(simResult)) {
      throw new Error("Contract simulation returned an unexpected result.");
    }

    const assembled = rpc.assembleTransaction(tx, simResult).build();

    onStatus?.("signing");
    const signedXdr = await signXDR(assembled.toXDR(), NETWORK_PASSPHRASE);

    const { ledger } = await submitAndPoll(signedXdr, onStatus);
    return { success: true, ledger };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Contract call failed.";
    reportError("contract.recordNetSettlementOnChain", err, { message });
    return { success: false, error: message };
  }
}

export async function getContractPayments(
  callerPublicKeyOrTripId: string,
  maybeTripId?: string
): Promise<GetPaymentsResult> {
  if (!contractReady("getContractPayments")) {
    return { payments: [], success: false, error: "Contract not configured." };
  }

  const callerPublicKey = maybeTripId ? callerPublicKeyOrTripId : "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const tripId = maybeTripId ?? callerPublicKeyOrTripId;

  if (!tripId) {
    return { payments: [], success: true };
  }

  try {
    const account  = await accountForReadOnlySimulation(callerPublicKey);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("get_payments", nativeToScVal(tripId, { type: "string" }))
      )
      .setTimeout(30)
      .build();

    const simResult = await sorobanServer.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      const errStr = String(simResult.error ?? "");
      const isArchived = /archived|expired|not\s*found|ttl/i.test(errStr);
      if (isArchived) {
        return { payments: [], success: true, isArchived: true };
      }
      throw new Error(decodeContractError(errStr) || "Simulation failed when reading trip payments.");
    }

    if (!rpc.Api.isSimulationSuccess(simResult)) {
      throw new Error("Simulation failed when reading trip payments.");
    }

    const retval = simResult.result?.retval;
    if (!retval) return { payments: [], success: true };

    const rawPayments = scValToNative(retval) as Array<{
      expense_id?: string;
      expenseId?: string;
      payer?: string;
      member?: string;
      amount?: bigint | number | string;
      amount_stroops?: bigint | number | string;
      asset?: string;
      tx_hash?: string;
      txHash?: string;
      timestamp?: bigint | number;
    }>;

    const defaultAsset = SETTLEMENT_ASSET_ID || "native";

    const payments: ContractPaymentRecord[] = Array.isArray(rawPayments)
      ? rawPayments.map((r) => ({
          tripId:        tripId,
          expenseId:     String(r.expense_id ?? r.expenseId ?? ""),
          payer:         String(r.payer ?? ""),
          member:        String(r.member ?? ""),
          amountStroops: typeof r.amount === "bigint"
            ? r.amount
            : BigInt(r.amount ?? r.amount_stroops ?? 0),
          asset:         r.asset ? String(r.asset) : defaultAsset,
          txHash:        String(r.tx_hash ?? r.txHash ?? ""),
          timestamp:     Number(r.timestamp ?? 0),
        }))
      : [];

    return { payments, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read contract payments.";
    const isArchived = /archived|expired|ttl/i.test(message);
    if (isArchived) {
      return { payments: [], success: true, isArchived: true };
    }
    console.warn("[StellarStar:contract] getContractPayments:", message);
    return { payments: [], success: false, error: message };
  }
}

export async function checkIsPaid(
  callerPublicKey: string,
  expenseId: string,
  memberPublicKey: string
): Promise<IsPaidResult> {
  if (!contractReady("checkIsPaid")) {
    return { paid: false, success: false, error: "Contract not configured." };
  }

  try {
    const account  = await accountForReadOnlySimulation(callerPublicKey);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: await getSuggestedBaseFee({ fallback: Number(SOROBAN_BASE_FEE) }),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "is_paid",
          nativeToScVal(expenseId,      { type: "string" }),
          new Address(memberPublicKey).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    const simResult = await sorobanServer.simulateTransaction(tx);

    if (
      rpc.Api.isSimulationError(simResult) ||
      !rpc.Api.isSimulationSuccess(simResult)
    ) {
      throw new Error("Simulation failed when checking payment status.");
    }

    const retval = simResult.result?.retval;
    const paid   = retval ? (scValToNative(retval) as boolean) : false;

    return { paid, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check on-chain payment status.";
    console.warn("[StellarStar:contract] checkIsPaid:", message);
    return { paid: false, success: false, error: message };
  }
}
