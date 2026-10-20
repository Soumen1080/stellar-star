"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BadgeCheck, Clock, ShieldCheck } from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { useToast } from "@/components/ui/Toast";
import { useWallet } from "@/hooks/useWallet";
import { claimContactProfile, type ClaimResult } from "@/lib/contacts/queries";
import { formatAddress, sanitizeText } from "@/lib/utils";

/**
 * A contact's owner sent this link to the person the contact describes.
 * Signing in (AuthGuard) proves control of the wallet; claiming binds that
 * proven wallet to the contact. The name on the contact proves nothing.
 */
export default function ClaimContactPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : "";
  const { publicKey } = useWallet();
  const { error: toastError } = useToast();
  const [claiming, setClaiming] = useState(false);
  const [result, setResult] = useState<ClaimResult | null>(null);

  const handleClaim = async () => {
    setClaiming(true);
    try {
      setResult(await claimContactProfile(token));
    } catch (err) {
      toastError("Could not claim profile", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setClaiming(false);
    }
  };

  return (
    <AuthGuard>
      <main className="min-h-screen bg-[#F6F6F6] flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-[#E5E5E5] bg-white p-6 text-center">
          {result ? (
            <>
              {result.status === "verified" ? (
                <BadgeCheck size={28} className="mx-auto mb-3 text-[#0F766E]" />
              ) : (
                <Clock size={28} className="mx-auto mb-3 text-amber-600" />
              )}
              <h1 className="text-lg font-black text-[#0F0F14] mb-2">
                {result.status === "verified" ? "Profile verified" : "Wallet change pending"}
              </h1>
              <p className="text-sm text-[#666]">
                {result.status === "verified"
                  ? `${formatAddress(result.ownerWallet, 6)} now sees “${sanitizeText(result.contactName)}” as verified to your wallet.`
                  : "Their saved address for you was different. Their active trips are notified first; your wallet is used once they apply the change."}
              </p>
              <Link href="/dashboard" className="mt-5 inline-block text-sm font-bold text-[#134E4A] hover:underline">
                Go to dashboard
              </Link>
            </>
          ) : (
            <>
              <ShieldCheck size={28} className="mx-auto mb-3 text-[#2DD4BF]" />
              <h1 className="text-lg font-black text-[#0F0F14] mb-2">Claim your profile</h1>
              <p className="text-sm text-[#666] mb-5">
                Someone saved you as a contact. Claiming links their entry to the wallet you are
                signed in with{publicKey ? ` (${formatAddress(publicKey, 6)})` : ""}, so they know
                payments go to you.
              </p>
              <button
                type="button"
                onClick={handleClaim}
                disabled={claiming || !token}
                className="w-full rounded-xl bg-[#0F0F14] py-2.5 text-sm font-bold text-[#2DD4BF] hover:bg-[#1A1A22] disabled:opacity-60"
              >
                {claiming ? "Claiming…" : "Claim with this wallet"}
              </button>
            </>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
