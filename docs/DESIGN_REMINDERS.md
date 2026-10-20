# Reminders and payment requests (#326)

The payer of an expense can politely ask a member for their unpaid share. The
request always appears in the app. It also goes out by email or push, but only
when the recipient opted in. No external message and no URL reveals anything
about the trip.

## Flow

1. **Remind**: on an unpaid share row, the payer clicks *Remind <name>* and can
   add a note (up to 280 characters). This calls `POST /api/reminders`.
2. **The server checks** (`lib/reminders/policy.ts`) that the sender can see the
   trip and expense (through their own RLS session), is the expense's payer, and
   is asking someone else for an **unpaid** share.
3. **Delivery** (`lib/reminders/service.ts`):
   - In-app is always on. The reminder appears in the recipient's dashboard
     inbox.
   - Email and push go out only if the recipient opted in, gave an address or
     endpoint, has not muted the trip or the sender, the operator configured a
     relay, and the recipient is under the per-channel limit.
4. **Deep link**: `/requests/<reminder uuid>`. The id is opaque and identifies
   the recipient and requested share. The page fetches nothing until the visitor
   signs in. `GET /api/reminders/<id>` answers only the request's sender and
   recipient (RLS, plus an explicit role check); everyone else gets the same 404
   as a missing id.

## What leaves the app

An external message contains a fixed subject and sentence, the deep link, and a
one-click unsubscribe link. It never includes the trip, expense, amount, note
or sender. `__tests__/reminders/reminders.test.ts` asserts this.

Transports are plain JSON webhooks to a relay the operator runs
(`REMINDER_EMAIL_WEBHOOK_URL`, `REMINDER_PUSH_WEBHOOK_URL`,
`REMINDER_WEBHOOK_SECRET`), so no provider SDK is bundled. If a channel has no
relay, its skip is recorded as `unconfigured`.

## Rate limits (`REMINDER_LIMITS`)

| Scope | Limit |
|---|---|
| Same sender → recipient → expense | 1 per 24 h (HTTP 429 with `Retry-After`) |
| Everything one sender sends | 30 per 24 h |
| External messages a recipient gets, per channel | 3 per 24 h (in-app still delivered) |

These use the shared `checkRateLimit` (Supabase-backed across instances).

## History

`reminder_events` is append-only (no UPDATE or DELETE policy). It records:

- who sent each reminder, when, and whether it was manual or scheduled;
- per channel: delivered, or skipped with a reason (`muted`, `no_address`,
  `unconfigured`, `rate_limited`, `delivery_failed`);
- the recipient's read, dismiss, mute/unmute trip and mute/unmute sender;
- the sender's cancel;
- opt-in/opt-out changes and unsubscribes.

A reminder to someone who muted it is still recorded, with state `muted`, so
history stays complete. It is hidden from their inbox and never leaves the app.

## Nothing is sent automatically

A reminder is created only by:

- an explicit click (`trigger: "manual"`), or
- a schedule a member created for their own receivables on a trip (*Automatic
  reminders* on the trip page; `reminder_schedules`, `trigger: "schedule"`).

The daily cron `/api/reminders/run` (`CRON_SECRET`) only processes those rows.
With none, it sends nothing. Each schedule is advanced before it runs, so
overlapping runs do not double-send, and the per-share limit still applies.

## Opting out

- Delivery settings live in the dashboard inbox (*Delivery*). Email and push are
  off by default.
- Every external message carries an HMAC-signed unsubscribe link
  (`/api/reminders/unsubscribe`). Its GET shows a confirmation page, so link
  scanners cannot unsubscribe anyone. POST turns that channel off and records
  `unsubscribed`.

## Storage

Migration `0013_payment_reminders.sql`: `payment_reminders`,
`reminder_events`, `reminder_preferences` (private to each wallet) and
`reminder_schedules` (private to the owner). All four have RLS.
