---
title: When the service isn't working
summary: How to tell a problem on your side from a service problem, and how incidents are communicated.
category: Getting started
version: 1.0.0
updated: 2026-11-21
owner: Platform on-call
reviewBy: 2027-05-21
tags: status, outage, incident, down, slow, degraded, maintenance, error, not working
---

## Check the status page first

The [status page](/status) shows the health of each part of Stellar-star:

- **App**: the website and its API.
- **Database**: saving and loading trips, expenses and members.
- **Notifications**: payment reminders and webhook deliveries.
- **Quotes**: exchange rates used to show amounts in other currencies.
- **Reconciliation**: recording confirmed payments against expenses.

Each part shows **Operational**, **Degraded performance**, **Outage** or
**Not reporting**. Not reporting means there is no live signal for it on this
deployment; it is not an all-clear.

## How incidents are communicated

When something is wrong, an incident is posted on the status page with the
affected parts and an update history. Updates follow a fixed rhythm based on
impact:

- **Critical** (most people can't pay or sign in): an update at least every
  30 minutes.
- **Major** (a key feature is down or badly slowed): at least every hour.
- **Minor** (limited impact, workarounds available): at least every 4 hours.

Every incident has a named owner. After a critical or major incident is
resolved, a postmortem explains what happened and what is changing.

## While there's an incident

- Payments already on the network are safe. A delay in recording them
  doesn't lose them ([details](/help/payments#reconciliation)).
- Avoid paying again just because a confirmation is slow. Look the payment
  up first ([how](/help/transaction-lookup)).
- If the status page shows everything operational but something still fails,
  check your wallet's network and connection ([wallet help](/help/wallet-setup)).
