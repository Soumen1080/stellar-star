"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { getReminderPreferences, saveReminderPreferences } from "@/lib/reminders/client";
import type { ReminderPreferences } from "@/types/reminder";

/**
 * Opt-in delivery channels (#326). In-app reminders are always on; email and
 * push stay off until turned on here, and messages carry only a sign-in link.
 */
export function ReminderPreferencesForm() {
  const { success, error } = useToast();
  const [prefs, setPrefs] = useState<ReminderPreferences | null>(null);
  const [email, setEmail] = useState("");
  const [pushEndpoint, setPushEndpoint] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getReminderPreferences()
      .then((p) => {
        setPrefs(p);
        setEmail(p.emailAddress ?? "");
        setPushEndpoint(p.pushEndpoint ?? "");
      })
      .catch(() => setPrefs(null));
  }, []);

  if (!prefs) return null;

  const save = async (patch: Parameters<typeof saveReminderPreferences>[0]) => {
    setSaving(true);
    try {
      const next = await saveReminderPreferences(patch);
      setPrefs(next);
      success("Reminder preferences saved");
    } catch (err) {
      error("Could not save preferences", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 text-xs text-[#555]">
      <p>In-app reminders are always on. Email and push are optional and only ever contain a sign-in link.</p>

      <fieldset className="space-y-1.5">
        <legend className="font-semibold text-[#0F0F14]">Email</legend>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email address for reminders"
          className="w-full rounded-lg border border-[#E5E5E5] px-2 py-1"
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.emailOptIn}
            disabled={saving}
            onChange={(e) => save({ emailOptIn: e.target.checked, emailAddress: email.trim() || null })}
          />
          Send me payment requests by email
        </label>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="font-semibold text-[#0F0F14]">Push</legend>
        <input
          type="url"
          value={pushEndpoint}
          onChange={(e) => setPushEndpoint(e.target.value)}
          placeholder="https://… (your notification relay endpoint)"
          aria-label="Push notification endpoint"
          className="w-full rounded-lg border border-[#E5E5E5] px-2 py-1"
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.pushOptIn}
            disabled={saving}
            onChange={(e) => save({ pushOptIn: e.target.checked, pushEndpoint: pushEndpoint.trim() || null })}
          />
          Send me payment requests as push notifications
        </label>
      </fieldset>

      {(prefs.mutedTripIds.length > 0 || prefs.mutedSenderWallets.length > 0) && (
        <p>
          Muted: {prefs.mutedTripIds.length} trip(s), {prefs.mutedSenderWallets.length} sender(s). Unmute from a
          request&apos;s page.
        </p>
      )}
    </div>
  );
}
