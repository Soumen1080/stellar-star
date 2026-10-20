"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BellRing, Settings2 } from "lucide-react";
import { Money } from "@/components/ui/Money";
import { useToast } from "@/components/ui/Toast";
import { actOnReminder, listReminders } from "@/lib/reminders/client";
import { paymentRequestPath } from "@/lib/reminders/policy";
import { formatAddress } from "@/lib/utils";
import type { PaymentReminder, ReminderAction } from "@/types/reminder";
import { ReminderPreferencesForm } from "./ReminderPreferencesForm";

/** In-app payment requests for the connected wallet (#326). */
export function ReminderInbox() {
  const { error } = useToast();
  const [reminders, setReminders] = useState<PaymentReminder[] | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);

  const load = useCallback(() => {
    listReminders("recipient")
      .then(setReminders)
      .catch(() => setReminders([]));
  }, []);

  useEffect(load, [load]);

  const act = async (id: string, action: ReminderAction) => {
    try {
      await actOnReminder(id, action);
      load();
    } catch (err) {
      error("Could not update the request", err instanceof Error ? err.message : "Please try again.");
    }
  };

  const open = (reminders ?? []).filter((r) => r.state === "delivered" || r.state === "read");

  return (
    <section className="rounded-2xl border border-[#E5E5E5] bg-white p-4" aria-labelledby="reminder-inbox-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="reminder-inbox-title" className="flex items-center gap-2 text-sm font-bold text-[#0F0F14]">
          <BellRing size={14} className="text-[#2DD4BF]" />
          Payment requests
          {open.length > 0 && (
            <span className="rounded-full bg-[#2DD4BF]/30 px-2 py-0.5 text-[10px] text-[#134E4A]">{open.length}</span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => setShowPrefs((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#555] hover:text-[#0F0F14]"
          aria-expanded={showPrefs}
        >
          <Settings2 size={11} /> Delivery
        </button>
      </div>

      {showPrefs && (
        <div className="mb-3 border-b border-[#F0F0F0] pb-3">
          <ReminderPreferencesForm />
        </div>
      )}

      {reminders === null ? (
        <p className="text-xs text-[#AAA]">Loading…</p>
      ) : open.length === 0 ? (
        <p className="text-xs text-[#AAA]">No open payment requests.</p>
      ) : (
        <ul className="space-y-2">
          {open.map((r) => (
            <li key={r.id} className="rounded-xl border border-[#F0F0F0] p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={paymentRequestPath(r.id)} className="font-semibold text-[#0F0F14] hover:underline">
                  {formatAddress(r.senderWallet, 4)} requested <Money amount={r.amount} asset={r.asset} />
                </Link>
                <span className="text-[#AAA]">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
              {r.note && <p className="mt-1 text-[#555]">“{r.note}”</p>}
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] font-semibold">
                <button type="button" onClick={() => act(r.id, "dismiss")} className="text-[#555] hover:text-[#0F0F14]">
                  Dismiss
                </button>
                <button type="button" onClick={() => act(r.id, "mute_trip")} className="text-[#555] hover:text-[#0F0F14]">
                  Mute this trip
                </button>
                <button type="button" onClick={() => act(r.id, "mute_sender")} className="text-[#555] hover:text-[#0F0F14]">
                  Mute sender
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
