"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BellRing, CheckCircle2, Lock } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { Money } from "@/components/ui/Money";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { actOnReminder, getPaymentRequest } from "@/lib/reminders/client";
import { formatAddress, sanitizeText } from "@/lib/utils";
import type { PaymentRequestContext, ReminderAction } from "@/types/reminder";

const EVENT_LABELS: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  skipped: "Not delivered",
  read: "Opened",
  dismissed: "Dismissed",
  cancelled: "Cancelled",
  muted_trip: "Trip muted",
  unmuted_trip: "Trip unmuted",
  muted_sender: "Sender muted",
  unmuted_sender: "Sender unmuted",
};

/**
 * A payment request deep link (#326). The URL is an opaque id: nothing about
 * the trip is in it, and nothing is fetched or shown until the visitor signs
 * in as the request's recipient or sender.
 */
export default function PaymentRequestPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  const { isAuthenticated, isLoading } = useAuth();
  const { error: toastError } = useToast();
  const [context, setContext] = useState<PaymentRequestContext | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(() => {
    getPaymentRequest(id)
      .then((c) => {
        setContext(c);
        setFailure(null);
      })
      .catch((err) => setFailure(err instanceof Error ? err.message : "This payment request is not available."));
  }, [id]);

  useEffect(() => {
    if (isAuthenticated && id) load();
  }, [isAuthenticated, id, load]);

  const act = async (action: ReminderAction) => {
    try {
      await actOnReminder(id, action);
      load();
    } catch (err) {
      toastError("Could not update the request", err instanceof Error ? err.message : "Please try again.");
    }
  };

  const shell = (children: ReactNode) => (
    <main className="min-h-screen bg-[#F6F6F6] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-[#E5E5E5] bg-white p-6">{children}</div>
    </main>
  );

  if (isLoading) return shell(<div className="flex justify-center"><Spinner size={32} /></div>);

  if (!isAuthenticated) {
    return shell(
      <div className="text-center">
        <Lock size={26} className="mx-auto mb-3 text-[#0F766E]" />
        <h1 className="mb-2 text-lg font-black text-[#0F0F14]">Sign in to view this payment request</h1>
        <p className="text-sm text-[#666]">
          For privacy, the details are only shown to the member it was sent to. Sign in with your wallet, then open
          this link again.
        </p>
        <Link href="/auth" className="mt-5 inline-block text-sm font-bold text-[#134E4A] hover:underline">
          Sign in
        </Link>
      </div>,
    );
  }

  if (failure) {
    return shell(
      <div className="text-center">
        <h1 className="mb-2 text-lg font-black text-[#0F0F14]">Request not available</h1>
        <p className="text-sm text-[#666]">{failure}</p>
        <Link href="/dashboard" className="mt-5 inline-block text-sm font-bold text-[#134E4A] hover:underline">
          Go to dashboard
        </Link>
      </div>,
    );
  }

  if (!context) return shell(<div className="flex justify-center"><Spinner size={32} /></div>);

  const { reminder, viewerRole } = context;
  const open = reminder.state === "delivered" || reminder.state === "read";

  return shell(
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {context.alreadyPaid ? (
          <CheckCircle2 size={20} className="text-[#0F766E]" />
        ) : (
          <BellRing size={20} className="text-[#2DD4BF]" />
        )}
        <h1 className="text-lg font-black text-[#0F0F14]">
          {context.alreadyPaid ? "Already paid" : viewerRole === "recipient" ? "Payment requested" : "Your request"}
        </h1>
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-[#888]">From</dt>
        <dd className="font-mono text-[#0F0F14]">{formatAddress(reminder.senderWallet, 6)}</dd>
        <dt className="text-[#888]">To</dt>
        <dd className="font-mono text-[#0F0F14]">{formatAddress(reminder.recipientWallet, 6)}</dd>
        {context.tripName && (
          <>
            <dt className="text-[#888]">Trip</dt>
            <dd className="text-[#0F0F14]">{sanitizeText(context.tripName)}</dd>
          </>
        )}
        {context.expenseTitle && (
          <>
            <dt className="text-[#888]">Expense</dt>
            <dd className="text-[#0F0F14]">{sanitizeText(context.expenseTitle)}</dd>
          </>
        )}
        <dt className="text-[#888]">Requested</dt>
        <dd className="font-bold text-[#0F0F14]"><Money amount={reminder.amount} asset={reminder.asset} /></dd>
        {context.outstanding !== null && !context.alreadyPaid && (
          <>
            <dt className="text-[#888]">Still due</dt>
            <dd className="text-[#0F0F14]"><Money amount={context.outstanding} asset={reminder.asset} /></dd>
          </>
        )}
      </dl>

      {reminder.note && <p className="rounded-xl bg-[#F8F8F8] p-3 text-sm text-[#555]">“{sanitizeText(reminder.note)}”</p>}

      <div className="flex flex-wrap gap-3 text-sm font-semibold">
        <Link href={`/trips/${encodeURIComponent(reminder.tripId)}`} className="text-[#134E4A] hover:underline">
          {viewerRole === "recipient" && !context.alreadyPaid ? "Open trip to pay" : "Open trip"}
        </Link>
        {viewerRole === "recipient" && open && (
          <button type="button" onClick={() => act("dismiss")} className="text-[#555] hover:text-[#0F0F14]">
            Dismiss
          </button>
        )}
        {viewerRole === "recipient" && (
          <>
            <button type="button" onClick={() => act("mute_trip")} className="text-[#555] hover:text-[#0F0F14]">
              Mute this trip
            </button>
            <button type="button" onClick={() => act("unmute_trip")} className="text-[#555] hover:text-[#0F0F14]">
              Unmute trip
            </button>
            <button type="button" onClick={() => act("mute_sender")} className="text-[#555] hover:text-[#0F0F14]">
              Mute sender
            </button>
            <button type="button" onClick={() => act("unmute_sender")} className="text-[#555] hover:text-[#0F0F14]">
              Unmute sender
            </button>
          </>
        )}
        {viewerRole === "sender" && open && (
          <button type="button" onClick={() => act("cancel")} className="text-[#555] hover:text-[#0F0F14]">
            Cancel request
          </button>
        )}
      </div>

      <section aria-labelledby="request-history">
        <h2 id="request-history" className="mb-1.5 text-xs font-bold uppercase tracking-wider text-[#888]">
          History
        </h2>
        <ol className="space-y-1 text-xs text-[#555]">
          {context.history.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-2">
              <span className="text-[#AAA]">{new Date(event.createdAt).toLocaleString()}</span>
              <span className="font-semibold">{EVENT_LABELS[event.kind] ?? event.kind}</span>
              {event.channel && <span>via {event.channel.replace("_", "-")}</span>}
              {event.detail && <span className="text-[#AAA]">({event.detail.replace(/_/g, " ")})</span>}
              <span className="font-mono text-[#AAA]">{formatAddress(event.actorWallet, 4)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>,
  );
}
