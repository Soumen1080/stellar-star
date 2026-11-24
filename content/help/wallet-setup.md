---
title: Set up a wallet and sign in
summary: Connect Freighter, xBull or Lobstr, match the network, sign in without paying a fee, and fund your account.
category: Getting started
version: 1.0.0
updated: 2026-11-21
owner: Support team
reviewBy: 2027-05-21
tags: wallet, freighter, xbull, lobstr, sign in, network, reserve, trustline, fund
---

Stellar-star never holds your funds or your keys. You use your own Stellar
wallet to sign in and to approve each payment.

## Supported wallets

- **Freighter**: browser extension, available from [freighter.app](https://www.freighter.app).
- **xBull**: browser extension and web wallet.
- **Lobstr**: browser extension and mobile wallet.

When you choose **Connect Wallet**, the app checks that the wallet is
installed, that it can share your address, that it can sign transactions, and
which network it is on. If any of these checks fail, you see why before any
signature prompt opens.

## Match the network

The app runs on one Stellar network, shown in the page footer (for example "Testnet Active").
Your wallet must be on the same network. If they differ, the app stops before
asking you to sign and shows a network warning. Switch networks in your
wallet's settings and try again.

## Sign in

Signing in asks your wallet to sign a one-time message, called a challenge.
It is not a transaction: it moves no funds and costs no fee. The signed
challenge proves you control the address, and you get a session that lasts up
to 24 hours.

> Stellar-star will never ask for your secret key or recovery phrase. Anyone
> who asks for them is not us. See [Staying safe](/help/safety).

## Fund your account

A new Stellar address has to be funded before it can pay anyone. Each account
keeps a small minimum balance in XLM, called the reserve, and every trustline
for another asset (such as USDC) adds to it. The app tells you when your
account is unfunded, or when the reserve is too low to add a trustline.

If someone invited you, they may be able to sponsor your account so you can
start without buying XLM first. You still sign the creation yourself, in your
own wallet.

## If something goes wrong

- **"Wallet not detected"**: install or unlock the extension, then reload the
  page.
- **"Address does not match"**: switch your wallet to the account you signed
  in with, or sign in again with the new one.
- **"Wallet cannot sign this transaction"**: the app can copy the unsigned
  transaction for you to import into a compatible wallet. Nothing is
  submitted until you sign it yourself.
- Nothing works at all? Check [system status](/status) before retrying.
