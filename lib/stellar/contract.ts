import {
  Contract,
  TransactionBuilder,
  Account,
  rpc,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";
import { sorobanServer } from "./soroban";
import { signXDR } from "@/lib/freighter";
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  HORIZON_URL,
} from "@/lib/utils/constants";
import type {
  ContractPaymentRecord,
  GetPaymentsResult,
  IsPaidResult,
} from "@/types/contract";
import { ContractErrorCode } from "@/types/contract";

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
        return "Trip ID or expense ID is missing — cannot record payment.";
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
      default:
        return `Contract error #${code}.`;
    }
  }
  return raw;
}

async function loadAccount(publicKey: string): Promise<Account> {
  const res = await fetch(
    `${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`,
    { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to load Stellar account (${res.status}). Verify your address is funded on testnet.`
    );
  }
  const data = (await res.json()) as { sequence: string };
  return new Account(publicKey, data.sequence);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function xlmToStroops(xlm: string): bigint {
  const parts = xlm.split(".");
  const whole = BigInt(parts[0] ?? "0");
  const fracStr = (parts[1] ?? "").padEnd(7, "0").slice(0, 7);
  const frac = BigInt(fracStr);
  return whole * 10_000_000n + frac;
}

export function stroopsToXlm(stroops: bigint | string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac  = n % 10_000_000n;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

function contractReady(caller: string): boolean {
  if (!CONTRACT_ID) {
    console.info(
      `[SettleX] ${caller}: CONTRACT_ID not set — skipping on-chain step. ` +
      "Deploy the contract and add NEXT_PUBLIC_CONTRACT_ID to .env.local."
    );
    return false;
  }
  return true;
}

export interface RecordPaymentParams {
  memberPublicKey: string;
  tripId: string;
  expenseId: string;
  payerPublicKey: string;
  amountXlm: string;
  txHash: string;
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
    fee: SOROBAN_BASE_FEE,
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

async function getPoolBalanceStroops(
  callerPublicKey: string,
  memberPublicKey: string,
): Promise<bigint> {
  const account = await loadAccount(callerPublicKey);
  const poolContractId = await getPoolContractId(callerPublicKey);
  const poolContract = new Contract(poolContractId);

  const tx = new TransactionBuilder(account, {
    fee: SOROBAN_BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(poolContract.call("balance_of", new Address(memberPublicKey).toScVal()))
    .setTimeout(30)
    .build();

  const simResult = await sorobanServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(decodeContractError(simResult.error));
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
): Promise<PoolPrecheckResult> {
  const requiredStroops = xlmToStroops(amountXlm);

  if (!contractReady("precheckPoolBalance")) {
    return { ok: false, requiredStroops, error: "Contract not configured." };
  }

  try {
    const balanceStroops = await getPoolBalanceStroops(callerPublicKey, memberPublicKey);
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
    onStatus,
  } = params;

  try {
    const account  = await loadAccount(memberPublicKey);
    const contract = new Contract(CONTRACT_ID);

    const amountStroops = xlmToStroops(amountXlm);
    const contractArgs = [
      nativeToScVal(tripId,           { type: "string" }),
      nativeToScVal(expenseId,        { type: "string" }),
      new Address(payerPublicKey).toScVal(),
      new Address(memberPublicKey).toScVal(),
      nativeToScVal(amountStroops,    { type: "i128" }),
      nativeToScVal(txHash,           { type: "string" }),
    ];

    const tx = new TransactionBuilder(account, {
      fee:              SOROBAN_BASE_FEE,
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

    onStatus?.("sending");
    const sendResult = await sorobanServer.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
    );

    if (sendResult.status === "ERROR") {
      throw new Error(
        `Contract send failed: ${sendResult.errorResult?.result()?.toXDR("base64") ?? "unknown error"}`
      );
    }

    onStatus?.("confirming");
    const txHash_ = sendResult.hash;

    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const pollResult = await sorobanServer.getTransaction(txHash_);

      if (pollResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { success: true, ledger: (pollResult as { ledger: number }).ledger };
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Contract call failed.";
    console.error("[SettleX:contract] recordPaymentOnChain error:", message);
    return { success: false, error: message };
  }
}

export async function getContractPayments(
  callerPublicKey: string,
  tripId: string
): Promise<GetPaymentsResult> {
  if (!contractReady("getContractPayments")) {
    return { payments: [], success: false, error: "Contract not configured." };
  }

  try {
    const account  = await loadAccount(callerPublicKey);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee:              SOROBAN_BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("get_payments", nativeToScVal(tripId, { type: "string" }))
      )
      .setTimeout(30)
      .build();

    const simResult = await sorobanServer.simulateTransaction(tx);

    if (
      rpc.Api.isSimulationError(simResult) ||
      !rpc.Api.isSimulationSuccess(simResult)
    ) {
      throw new Error("Simulation failed when reading trip payments.");
    }

    const retval = simResult.result?.retval;
    if (!retval) return { payments: [], success: true };

    const rawPayments = scValToNative(retval) as Array<{
      expense_id: string;
      payer: string;
      member: string;
      amount: bigint;
      tx_hash: string;
      timestamp: bigint;
    }>;

    const payments: ContractPaymentRecord[] = rawPayments.map((r) => ({
      tripId:        tripId,
      expenseId:     r.expense_id,
      payer:         r.payer,
      member:        r.member,
      amountStroops: r.amount,
      txHash:        r.tx_hash,
      timestamp:     Number(r.timestamp),
    }));

    return { payments, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read contract payments.";
    console.warn("[SettleX:contract] getContractPayments:", message);
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
    const account  = await loadAccount(callerPublicKey);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee:              SOROBAN_BASE_FEE,
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
    console.warn("[SettleX:contract] checkIsPaid:", message);
    return { paid: false, success: false, error: message };
  }
}
