"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useTrustline } from "@/hooks/useTrustline";
import { getAccountState, describeOnboardingNeed, canReceive, stroopsToXlm, type AccountState, type OnboardingNeed } from "@/lib/stellar/accountState";
import { getSuggestedBaseFee } from "@/lib/stellar/fees";
import { parseAssetKey, resolveAsset, formatAssetLabel, type AssetRef } from "@/lib/stellar/assets";
import { Money } from "@/lib/money";
import { useWallet } from "@/hooks/useWallet";

interface AssetReadinessPanelProps {
  publicKey: string;
  assetKey: string;
  requiredAmount: string;
  recipientAddress: string;
  onReadyChange?: (ready: boolean) => void;
}

function statusMessage(need: OnboardingNeed): string {
  switch (need.kind) {
    case "trustline_missing": return "Add a trustline before receiving this asset.";
    case "trustline_unauthorized": return "The issuer has not authorized this trustline.";
    case "trustline_auth_maintain": return "Issuer authorization only allows existing liabilities; new payments are blocked.";
    case "trustline_at_limit": return "The trustline has no remaining receive capacity.";
    case "trustline_sponsored": return "Trustline is authorized; its reserve is sponsored.";
    case "account_creation": return "This wallet account is not funded on the selected network.";
    default: return "Trustline and issuer authorization are ready.";
  }
}

function friendlyTrustlineError(message: string | null): string | null {
  if (!message) return null;
  if (/XDR was copied/i.test(message)) return "This wallet cannot sign the trustline transaction. Unsigned XDR was copied; import it into a compatible Stellar wallet and verify the network and address before signing.";
  if (/InsufficientReserve|reserve/i.test(message)) return "There is not enough spendable XLM to add this trustline and keep the required reserve. Fund the wallet, then retry.";
  if (/reject|denied|cancel/i.test(message)) return "You cancelled the trustline signature. No trustline transaction was submitted.";
  if (/network|passphrase/i.test(message)) return "The wallet network changed. Switch to the app network, reconnect, and try again.";
  return "The trustline could not be added. Refresh the account status and retry, or contact the asset issuer if authorization is required.";
}

export function AssetReadinessPanel({ publicKey, assetKey, requiredAmount, recipientAddress, onReadyChange }: AssetReadinessPanelProps) {
  const { network, appNetwork, networkMismatch } = useWallet();
  const asset = useMemo<AssetRef>(() => parseAssetKey(assetKey), [assetKey]);
  const definition = useMemo(() => resolveAsset(asset), [asset]);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [recipient, setRecipient] = useState<AccountState | null>(null);
  const [feeStroops, setFeeStroops] = useState<bigint | null>(null);
  const [need, setNeed] = useState<OnboardingNeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { phase, error: trustlineError, addTrustline } = useTrustline(asset);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accountState, recipientState, fee] = await Promise.all([
        getAccountState(publicKey), getAccountState(recipientAddress), getSuggestedBaseFee(),
      ]);
      setAccount(accountState);
      setRecipient(recipientState);
      setFeeStroops(BigInt(fee) * 2n); // payment plus optional settlement-contract operation
      setNeed(describeOnboardingNeed(accountState, asset));
    } catch {
      setAccount(null);
      setRecipient(null);
      setFeeStroops(null);
      setNeed(null);
      setError("Could not check this wallet on the selected Stellar network. Try again before paying.");
    } finally {
      setLoading(false);
    }
  }, [publicKey, recipientAddress, asset]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (phase === "done") void refresh(); }, [phase, refresh]);

  const feeXlm = feeStroops === null ? null : stroopsToXlm(feeStroops);
  const amount = Money.tryParse(requiredAmount);
  const senderLine = account?.trustlines.find((line) => assetKey === "native" ? false : `${line.code}:${line.issuer}` === assetKey);
  const recipientLine = recipient?.trustlines.find((line) => assetKey === "native" ? false : `${line.code}:${line.issuer}` === assetKey);
  const available = account && (definition.isNative
    ? Money.parse(stroopsToXlm(account.spendableStroops))
    : senderLine ? Money.parse(stroopsToXlm(senderLine.balanceStroops > senderLine.sellingLiabilitiesStroops ? senderLine.balanceStroops - senderLine.sellingLiabilitiesStroops : 0n)) : null);
  const balanceSufficient = !!available && !!amount && available.greaterThanOrEqual(amount.plus(definition.isNative && feeXlm ? feeXlm : "0"));
  const feeSufficient = !!account && !!feeStroops && account.spendableStroops >= feeStroops;
  const trustlineReady = definition.isNative || !!senderLine && (senderLine.isAuthorized || senderLine.isAuthorizedToMaintainLiabilities);
  const recipientCapacity = recipientLine
    ? recipientLine.limitStroops - recipientLine.balanceStroops - recipientLine.sellingLiabilitiesStroops
    : null;
  const recipientReady = !!recipient && canReceive(recipient, asset) && (definition.isNative || (!!recipientLine && recipientCapacity !== null && !!amount && recipientCapacity >= amount.toStroops()));
  const networkReady = !networkMismatch && network === appNetwork;
  const ready = !loading && !error && !!account && definition.trusted && balanceSufficient && feeSufficient && trustlineReady && recipientReady && networkReady;
  useEffect(() => { onReadyChange?.(ready); }, [ready, onReadyChange]);

  return (
    <section aria-label="Payment readiness" className={`space-y-2 rounded-xl border p-3 text-xs ${ready ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-bold text-[#0F0F14]">Before you pay · {formatAssetLabel(asset)}</h4>
        <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh readiness" className="rounded p-1 hover:bg-black/5 disabled:opacity-40">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {loading ? <p className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Checking balance, trustline, reserve, issuer authorization, and network…</p>
        : error ? <p role="alert" className="text-amber-900">{error}</p>
          : <>
            {networkMismatch || network !== appNetwork ? <p role="alert" className="inline-flex items-center gap-1 text-amber-900"><AlertTriangle size={13} /> Wallet network {network ?? "unknown"}; switch to {appNetwork} before signing.</p>
              : <p>Network: {network} ✓</p>}
            <p>Spendable {definition.isNative ? "XLM" : definition.code}: {available?.format() ?? "unavailable"} {definition.isNative ? "XLM" : definition.code}</p>
            <p>XLM reserve locked: {account ? stroopsToXlm(account.reserveStroops) : "unavailable"} XLM · spendable excludes reserve and liabilities.</p>
            <p>Required: {requiredAmount} {definition.code} · estimated fee: {feeXlm ?? "unavailable"} XLM</p>
            <p>Issuer: {definition.isNative ? "native asset" : definition.trusted ? "known asset" : "not on this network’s trusted asset list"}</p>
            <p>{definition.isNative ? "Native XLM has no trustline." : !senderLine ? "Your wallet has no trustline for this asset." : senderLine.isAuthorized ? "Your trustline is authorized by the issuer." : senderLine.isAuthorizedToMaintainLiabilities ? "Issuer authorization only permits existing liabilities; sending existing holdings may be possible, but receiving is blocked." : "The issuer has not authorized your trustline."}</p>
            <p>Recipient: {!recipient ? "could not check" : recipientReady ? "account is authorized and has enough trustline capacity ✓" : "account cannot receive this amount yet; ask them to fund the account, add/authorize the trustline, or increase its limit."}</p>
            {need?.kind === "trustline_at_limit" && <p>Your trustline is at its receive limit; this does not prevent sending an existing balance.</p>}
            {need?.kind === "trustline_sponsored" && <p>{statusMessage(need)}</p>}
            {need?.kind === "trustline_missing" && <p>Creating the trustline will lock {stroopsToXlm(need.reserveStroops)} XLM in reserve. Nothing is created until you choose the button and sign.</p>}
            {account?.sponsored && <p>Some reserves are sponsored; {account.sponsorId ? `sponsor ${account.sponsorId.slice(0, 5)}…${account.sponsorId.slice(-4)}.` : "a sponsor is recorded."} Current spendable balance already excludes locked reserve.</p>}
            {need?.kind === "trustline_missing" && <button type="button" disabled={!need.affordable || loading || phase === "awaiting_signature" || phase === "submitting" || !networkReady}
              onClick={() => void addTrustline(publicKey)} className="rounded-lg bg-[#0F0F14] px-3 py-1.5 font-bold text-white disabled:opacity-40">
              {phase === "awaiting_signature" ? "Confirm in wallet…" : phase === "submitting" ? "Submitting…" : `Add ${definition.code} trustline`}
            </button>}
            {trustlineError && <p role="alert" className="text-amber-900">{friendlyTrustlineError(trustlineError)}</p>}
            {!definition.trusted && <p role="alert" className="font-semibold text-amber-900">Payment is blocked until this asset and issuer are approved for this network.</p>}
            {!balanceSufficient && <p className="text-amber-900">Balance is below the amount plus applicable fee estimate.</p>}
            {ready && <p className="inline-flex items-center gap-1 font-semibold text-emerald-800"><CheckCircle2 size={13} /> Ready to continue to your wallet for an explicit signature.</p>}
          </>}
    </section>
  );
}
