"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { sendPaymentReminder } from "@/lib/reminders/client";
import { MAX_NOTE_LENGTH } from "@/lib/reminders/policy";

interface RemindButtonProps {
  tripId: string;
  expenseId: string;
  memberId: string;
  memberName: string;
}

/**
 * Lets the payer of an expense ask a member for their share (#326). Sending
 * only ever happens from this click; the server enforces who may ask and the
 * once-a-day-per-share limit.
 */
export function RemindButton({ tripId, expenseId, memberId, memberName }: RemindButtonProps) {
  const { success, error } = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      const { channels } = await sendPaymentReminder({ tripId, expenseId, memberId, note: note.trim() || undefined });
      const external = channels.filter((c) => c !== "in_app");
      success(
        "Payment request sent",
        external.length > 0
          ? `${memberName} was notified in the app and by ${external.join(" and ")}.`
          : `${memberName} will see it in the app.`,
      );
      setOpen(false);
      setNote("");
    } catch (err) {
      error("Could not send the request", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#555] hover:text-[#0F0F14]"
      >
        <BellRing size={11} className="text-[#2DD4BF]" />
        Remind {memberName}
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label className="sr-only" htmlFor={`remind-note-${expenseId}-${memberId}`}>
        Optional note
      </label>
      <input
        id={`remind-note-${expenseId}-${memberId}`}
        value={note}
        maxLength={MAX_NOTE_LENGTH}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a friendly note (optional)"
        className="min-w-0 flex-1 rounded-lg border border-[#E5E5E5] px-2 py-1"
      />
      <button
        type="submit"
        disabled={sending}
        className="rounded-lg bg-[#0F0F14] px-2.5 py-1 font-semibold text-white disabled:opacity-40"
      >
        {sending ? "Sending..." : "Send request"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-[#888] hover:text-[#0F0F14]">
        Cancel
      </button>
    </form>
  );
}
