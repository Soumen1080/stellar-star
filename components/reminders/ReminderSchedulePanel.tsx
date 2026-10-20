"use client";

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  createReminderSchedule,
  disableReminderSchedule,
  listReminderSchedules,
} from "@/lib/reminders/client";
import type { ReminderSchedule } from "@/types/reminder";

const INTERVALS = [1, 3, 7, 14, 30];

/**
 * Optional automatic reminders for what others owe *you* on this trip (#326).
 * Off unless you turn it on; nothing is ever sent on a default schedule.
 */
export function ReminderSchedulePanel({ tripId }: { tripId: string }) {
  const { success, error } = useToast();
  const [schedule, setSchedule] = useState<ReminderSchedule | null | undefined>(undefined);
  const [interval, setIntervalDays] = useState(7);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listReminderSchedules()
      .then((all) => setSchedule(all.find((s) => s.tripId === tripId && s.active) ?? null))
      .catch(() => setSchedule(null));
  }, [tripId]);

  if (schedule === undefined) return null;

  const enable = async () => {
    setBusy(true);
    try {
      setSchedule(await createReminderSchedule(tripId, interval));
      success("Automatic reminders on", `Members who owe you will be reminded every ${interval} day(s).`);
    } catch (err) {
      error("Could not turn on reminders", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!schedule) return;
    setBusy(true);
    try {
      await disableReminderSchedule(schedule.id);
      setSchedule(null);
      success("Automatic reminders off");
    } catch (err) {
      error("Could not turn off reminders", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#E5E5E5] bg-white px-3 py-2 text-xs text-[#555]">
      <CalendarClock size={13} className="text-[#2DD4BF]" />
      {schedule ? (
        <>
          <span>
            Reminding members who owe you every {schedule.intervalDays} day(s). Next:{" "}
            {new Date(schedule.nextRunAt).toLocaleDateString()}.
          </span>
          <button type="button" disabled={busy} onClick={disable} className="font-semibold text-[#0F0F14] underline disabled:opacity-40">
            Turn off
          </button>
        </>
      ) : (
        <>
          <span>Automatic reminders are off.</span>
          <label className="sr-only" htmlFor={`reminder-interval-${tripId}`}>
            Interval
          </label>
          <select
            id={`reminder-interval-${tripId}`}
            value={interval}
            onChange={(e) => setIntervalDays(Number(e.target.value))}
            className="rounded-lg border border-[#E5E5E5] px-1.5 py-0.5"
          >
            {INTERVALS.map((d) => (
              <option key={d} value={d}>
                every {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={enable} className="font-semibold text-[#0F0F14] underline disabled:opacity-40">
            Turn on
          </button>
        </>
      )}
    </div>
  );
}
