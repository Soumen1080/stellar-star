---
title: Look up a transaction
summary: Find a payment's transaction hash, open it in a public explorer, and read what it shows.
category: Payments
version: 1.0.0
updated: 2026-11-21
owner: Support team
reviewBy: 2027-05-21
tags: transaction, hash, explorer, stellar expert, ledger, memo, lookup, proof, receipt
---

Every Stellar payment has a transaction hash: 64 characters of letters
`a`–`f` and digits. The hash is public proof that the payment happened, and
anyone can look it up.

## Find the hash

- Open the expense and look at the share you paid. A paid share shows its
  transaction hash.
- In your wallet, open the payment's history. Wallets show the same hash.

## Open it in an explorer

Use a public Stellar explorer such as
[Stellar Expert](https://stellar.expert/explorer/public). Choose the same
network the app uses (Public or Testnet, shown in the footer) and paste the
hash into the search box.

## What the explorer shows

- **Source**: the account that paid, which should be yours.
- **Destination**: the account that received the payment. This should be
  the person who paid for the expense.
- **Amount and asset**: what was sent, such as XLM or USDC.
- **Ledger and time**: when the network confirmed it. A ledger number means
  the payment is final.
- **Memo**: Stellar-star never puts names or personal details in memos.

## If you can't find it

- **Not found**: check that the explorer is set to the same network as the
  app, and that you copied the full hash.
- **Just submitted**: confirmation usually takes a few seconds. Wait a moment
  and search again.
- **Found, but the expense still shows unpaid**: your payment is safe on the
  network. Reconciliation will record it ([details](/help/payments#reconciliation)).
  Don't pay a second time.
