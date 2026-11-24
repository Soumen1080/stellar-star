---
title: Pay your share and understand payment states
summary: How a payment moves from your wallet to a recorded settlement, what each state means, and why retrying is safe.
category: Payments
version: 1.0.0
updated: 2026-11-21
owner: Support team
reviewBy: 2027-05-21
tags: pay, payment, settle, share, pending, confirmed, recorded, off-chain, reconciliation, retry, double payment
---

Paying a share sends a real Stellar payment from your wallet to the person
who paid for the expense. Stellar-star prepares the transaction; you review
and sign it in your own wallet.

## What happens when you pay

1. **Prepare**: the app builds a payment for your exact share.
2. **Sign**: your wallet shows the destination and amount. Check both, then
   approve.
3. **Submit**: the signed payment is sent to the Stellar network.
4. **Record**: once the network confirms it, the settlement is recorded
   against the expense so nobody can be asked to pay that share twice.

## Payment states

- **Confirmed in the contract**: done. The payment is on the network and
  recorded for the expense.
- **Payment sent, recorded off-chain only**: your payment reached the
  network and the app recorded it, but the on-chain settlement record could
  not be written yet. Your money has moved; do not pay again. The record is
  completed automatically by [reconciliation](#reconciliation).
- **Pending**: the payment was submitted and is waiting for network
  confirmation. This usually takes a few seconds.
- **Failed** or **blocked**: nothing was sent. The message explains why, for
  example an unfunded account, a missing trustline or a network mismatch.
  Fix the cause and try again.

## Retrying is safe

If the app loses connection or you tap Pay twice, it recognises the repeated
request and does not create a second payment. Before paying again after an
error, look up the transaction ([how](/help/transaction-lookup)). If it
succeeded, wait for it to be recorded instead of paying again.

## Reconciliation

Stellar-star regularly checks pending settlements against the network. A
payment confirmed on the network but not yet recorded is completed
automatically. A payment that can't be matched unambiguously is escalated
for review instead of being guessed. If reconciliation is delayed, the
[status page](/status) says so.

## Disputes

If an expense is disputed, settlement for it is paused until the dispute is
resolved. A dispute is not a refund. To fix a wrong amount, see
[Fix a mistake](/help/corrections).
