# Incident communication

Owner: Platform on-call
Review by: 2027-05-21
Version: 1.0.0

How we tell users about a service problem on the [status page](/status): who
owns the message, how often it is updated, and what is published once the
incident is over. The cadence and postmortem rules here are also enforced in
code (`lib/status/incidents.ts`), and CI rejects an incident entry that breaks
them.

## Severity, cadence and postmortem

| Severity | Label | Meaning | Public update at least every | After resolution |
| --- | --- | --- | --- | --- |
| `sev1` | Critical | Most people cannot sign in, pay, or load their data. | 30 minutes | Full postmortem within 5 business days |
| `sev2` | Major | A key feature is unavailable or badly degraded for many people. | 60 minutes | Full postmortem within 10 business days |
| `sev3` | Minor | Limited impact, or a workaround is available. | 4 hours | Resolution summary on the incident |

If you're unsure, pick the higher severity. Downgrading later is cheaper than
under-communicating.

## Roles

- **Incident owner**: the on-call engineer who declares the incident. They
  own the timeline and the decision to resolve. Recorded as a role, not a
  person, in the `owner` field, e.g. `Platform on-call`.
- **Communications**: the incident owner by default. On a `sev1`, hand
  communications to a second person so updates never wait on debugging.
- **Postmortem author**: the incident owner, unless they hand it over
  explicitly in the resolved update.

## Which component

| Component | Use it when |
| --- | --- |
| `app` | Pages or API requests fail or are slow, whatever the cause. |
| `database` | Saving or loading trips, expenses or members fails or is slow. |
| `notifications` | Reminders or webhooks are delayed or not delivered. |
| `quotes` | Exchange rates are missing, stale or wrong. |
| `reconciliation` | Confirmed payments are not being recorded against expenses. |

Describe impact, not infrastructure. Never name hosts, vendors, internal
services, error messages, wallet addresses or anyone's data.

## Publishing an incident

Add an entry to `content/status/incidents.json` and merge it. The status page
shows it on the next deploy, and every affected component is marked at least
as `degraded` or `outage` (the `impact` field) while it is open.

```json
{
  "id": "2026-11-21-payment-recording-delay",
  "title": "Delays recording confirmed payments",
  "severity": "sev2",
  "impact": "degraded",
  "components": ["reconciliation"],
  "owner": "Platform on-call",
  "startedAt": "2026-11-21T09:00:00Z",
  "updates": [
    {
      "at": "2026-11-21T09:10:00Z",
      "status": "investigating",
      "message": "Confirmed payments are taking longer than usual to show as recorded. Payments already sent are safe; please don't pay again."
    }
  ]
}
```

Each follow-up update is appended with status `investigating`, `identified`,
`monitoring` or `resolved`, no later than the cadence above. If an update is
overdue, the status page says so.

## Update templates

**Investigating**
> We're investigating reports that *[what people experience]*. *[What is
> safe or what to avoid, e.g. "Payments already sent are safe; please don't
> pay again."]* Next update within *[cadence]*.

**Identified**
> We've found the cause of *[symptom]* and are *[fixing it / rolling back]*.
> *[Workaround, if any.]* Next update within *[cadence]*.

**Monitoring**
> A fix is in place and *[symptom]* is recovering. We're watching to make
> sure it holds. *[Anything users should do, e.g. "Delayed reminders are
> being sent now."]*

**Resolved**
> *[Symptom]* is resolved as of *[time, UTC]*. *[What, if anything, users
> need to do.]* *[sev1/sev2: "We'll publish a postmortem by [date]."]*

Set `resolvedAt` to the resolved update's time.

## Postmortem templates

### Full postmortem (`sev1`, `sev2`)

Publish within the deadline above and link it from the incident's
`postmortemUrl` (an `https://` URL or an in-app `/` path). CI rejects a
resolved `sev1` or `sev2` incident without one.

```markdown
# [Title] — postmortem

Severity: [Critical | Major]   Owner: [role]   Published: [date]

## Summary
Two or three sentences: what people experienced, for how long, and that it is fixed.

## Impact
Who was affected and how. Components affected. Whether any payment, data or
notification was lost, duplicated or delayed, and what happened to it.

## Timeline (UTC)
- HH:MM detected / declared
- HH:MM identified
- HH:MM mitigated
- HH:MM resolved

## Root cause
What failed and why, in plain language. No hostnames, credentials or personal data.

## What went well / what didn't
Detection, response, communication.

## Actions
| Action | Owner (role) | Due |
| --- | --- | --- |
```

### Resolution summary (`sev3`)

One or two sentences in the incident's `resolutionSummary`: what happened,
what fixed it, and whether anything changes for users. CI rejects a resolved
`sev3` incident without one.

## Review

This document, the status component descriptions and the help articles each
record an owner and a review date. `npm run help:check` (run in CI) fails when
a review date has passed, so stale guidance gets noticed. When you review,
update the content, bump `Version`, and push `Review by` up to six months out.
Also see the [operations runbook](RUNBOOK.md).
