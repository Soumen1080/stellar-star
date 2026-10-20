"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { describeNoticeRemaining, walletChangesForTrip } from "@/lib/contacts/contacts";
import { fetchWalletChanges } from "@/lib/contacts/queries";
import { formatAddress, sanitizeText } from "@/lib/utils";
import type { ContactWalletChange } from "@/types/contact";

/**
 * Warns every member of an active trip that someone's saved wallet is about
 * to change, before the new address is used anywhere. Row visibility is
 * decided by RLS: members of an affected trip can read the change.
 */
export function TripWalletChangeBanner({ tripId }: { tripId: string }) {
  const [changes, setChanges] = useState<ContactWalletChange[]>([]);

  useEffect(() => {
    let active = true;
    fetchWalletChanges()
      .then((rows) => {
        if (active) setChanges(walletChangesForTrip(rows, tripId));
      })
      // Best-effort notice: a failure here must not break the trip page.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [tripId]);

  if (changes.length === 0) return null;

  return (
    <div role="status" className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      {changes.map((change) => (
        <p key={change.id} className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>{sanitizeText(change.contactName)}</strong>&apos;s wallet is changing
            {change.oldWallet ? ` from ${formatAddress(change.oldWallet, 4)}` : ""} to{" "}
            {formatAddress(change.newWallet, 4)}
            {change.verified ? " (proven by its owner)" : " (not yet verified)"}. It can be used{" "}
            {describeNoticeRemaining(change.noticeUntil)}. Past payments are unaffected — check
            before sending anything new.
          </span>
        </p>
      ))}
    </div>
  );
}
