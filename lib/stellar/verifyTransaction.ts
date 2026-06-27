import { HORIZON_URL } from "@/lib/utils/constants";

export interface VerifyTxParams {
  txHash: string;
  expectedSource: string;
  expectedDestination: string;
  expectedAmountXlm: string;
}

export async function verifyPaymentTransaction({
  txHash,
  expectedSource,
  expectedDestination,
  expectedAmountXlm,
}: VerifyTxParams): Promise<{ valid: boolean; error?: string }> {
  try {
    const txRes = await fetch(`${HORIZON_URL}/transactions/${txHash}?_ts=${Date.now()}`);
    if (!txRes.ok) {
      if (txRes.status === 404) {
        return { valid: false, error: "Transaction not found on the network." };
      }
      return { valid: false, error: `Failed to fetch transaction (HTTP ${txRes.status}).` };
    }
    
    const tx = await txRes.json();
    
    if (!tx.successful) {
      return { valid: false, error: "Transaction failed on the ledger." };
    }

    const opsRes = await fetch(`${HORIZON_URL}/transactions/${txHash}/operations?_ts=${Date.now()}`);
    if (!opsRes.ok) {
      return { valid: false, error: `Failed to fetch transaction operations (HTTP ${opsRes.status}).` };
    }
    
    const ops = await opsRes.json();
    if (!ops._embedded || !ops._embedded.records || ops._embedded.records.length === 0) {
      return { valid: false, error: "No operations found in transaction." };
    }
    
    const matchingOp = ops._embedded.records.find((op: any) => {
      if (op.type !== "payment") return false;
      
      const opSource = op.source_account || tx.source_account;
      if (opSource !== expectedSource) return false;
      
      if (op.to !== expectedDestination) return false;
      if (op.asset_type !== "native") return false;
      
      const opAmount = parseFloat(op.amount);
      const expected = parseFloat(expectedAmountXlm);
      
      if (Math.abs(opAmount - expected) > 0.0000001) return false;
      
      return true;
    });

    if (!matchingOp) {
      return { valid: false, error: "No matching payment operation found in transaction." };
    }

    return { valid: true };
  } catch (error: any) {
    return { valid: false, error: error.message || "Network error verifying transaction." };
  }
}
