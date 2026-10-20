# Recurring expenses and scheduled drafts (#319)

Templates describe a repeating bill (rent, utilities, subscriptions). Each due
occurrence becomes a **draft**. A draft only becomes an expense when a member
opens it in the normal expense form, reviews it, and saves it. Nothing in this
feature submits a payment or asks for a wallet signature, and
`__tests__/recurring/noAutoSigning.test.ts` fails if any recurring file imports
payment, wallet, or Stellar code.

## What a template holds

A template has a cadence (every N days/weeks/months/years), start and end
dates, the trip's members, an equal split, the payer, an amount rule, a
category, and a reminder preference.

- **Amount rule.** `fixed` uses the same amount every time. `variable` leaves
  the amount for the reviewer to enter, with an optional estimate pre-filled.
- **Reminder preference.** The draft is created this many days before the due
  date (0–30), so it shows up early.
- **Month-end dates.** A series that starts on the 31st falls on the last day
  of shorter months (Feb 28/29) and returns to the 31st afterwards.

## Generation (idempotent)

`generateDueDrafts()` inserts one draft per due occurrence. It uses
`ON CONFLICT (template_id, occurrence_date) DO NOTHING`, enforced by the
`expense_drafts_one_per_occurrence` unique key, so re-runs and concurrent runs
never create duplicates. Each draft records its `template_id` and
`template_version` (its source) and a frozen copy of the payload.

Generation runs in two places:
- `GET /api/recurring/run`: a daily cron (see `vercel.json`) that needs
  `Authorization: Bearer $CRON_SECRET` and the service-role key.
- The trip's **Recurring** tab, which catches up under the member's own RLS
  when the tab is opened. This covers deployments without a scheduler.

If generation stops for a while, it catches up at most 62 days back.

## Editing without changing history

- **Pause and resume.** Resuming moves `generate_from` to today, so dates that
  fell inside the pause are not back-filled.
- **Skip or edit one future occurrence.** This is stored in
  `recurring_expense_exceptions`. Past dates are refused.
- **Edit the series.** Changes are version-checked and apply only to drafts
  created afterwards. Existing drafts keep their frozen payload, and a trigger
  makes `payload`, `template_id`, and `occurrence_date` immutable. Saved
  expenses are separate rows and are never touched.
- **End a series.** Templates are ended, not deleted, so every draft keeps a
  valid source.
