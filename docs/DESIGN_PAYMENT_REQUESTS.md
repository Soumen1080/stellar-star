# QR and link payment requests (#327)

The SEP-0007 QR now produces a payment request for a specific outstanding share
(each unpaid share row) or a net settlement (each row in *Settle*).

## What a request contains (`lib/qr/paymentRequest.ts`)

| Field | Notes |
|---|---|
| `destination` | The creditor's account. Validated with `StrKey`. |
| `asset` | Canonical key: `native` or `CODE:ISSUER`. A bare code is refused. |
| `amount` | Exact, at 7-decimal ledger precision. Never rounded: more than 7 decimals is an error. |
| `memo` | `SSR:<reference>`: a 12-hex intent reference, never a trip or expense name. |
| `expiresAt` | Unix seconds. 5 minutes to 7 days ahead (default 24 h). |
| `network`, `networkPassphrase` | The app's network. |
| `items` | The `(expenseId, memberId, amount)` shares the request settles. |

`reference` is a hash over every committed field. Editing any of them, even
consistently, makes the link decode as "altered" instead of showing a fake
request as genuine.

## Encodings

1. **QR, when the payer's account is readable: SEP-0007 `tx` URI.** It carries
   an unsigned payment with:
   - time-bounds `maxTime = expiresAt`: after expiry the network rejects it
     (`tx_too_late`);
   - the app's network passphrase: a signature is valid on that network only;
   - the payer's current sequence number: once the payer has made any other
     transaction (including paying this debt), the envelope can no longer be
     submitted (`tx_bad_seq`).
2. **Fallback: SEP-0007 `pay` URI** (the *Copy wallet URI* button, and the QR
   when the account cannot be read). It includes `destination`, `amount`,
   `asset_code`/`asset_issuer`, `memo`/`memo_type`, `network_passphrase` and a
   human-readable `msg` (≤ 300 characters) that names the amount, recipient,
   network and expiry for the wallet to display.
3. **App link `/pay?r=…`** (*Copy app link*). It requires sign-in, then shows
   the preview and pays through the normal settlement path (intents,
   attestation, on-chain record).

## Preview before signing

`describePaymentRequest()` renders every field in plain words: recipient,
payer, amount with asset, canonical asset, memo, network, expiry and what it
covers. Both the QR panel and the `/pay` page show it before any wallet prompt.
The `pay` URI's `msg` gives wallets the same summary.

## What cannot be submitted

`checkPaymentRequest()` runs against live trip data when `/pay` opens, and again
right before the wallet is asked to sign. It blocks:

- `EXPIRED`;
- `NETWORK_MISMATCH` (request vs. app) and `WALLET_NETWORK_MISMATCH`;
- `ALREADY_PAID`, fully or partly;
- `DESTINATION_MISMATCH`: the request's recipient is not who the share is owed
  to;
- `WRONG_PAYER`: addressed to another wallet;
- `AMOUNT_CHANGED`: the share changed or no longer exists.

In the panel, an expired request is shown as expired and cannot be copied. The
`tx` QR enforces expiry, network and already-paid on-chain, as described above.

## Wallet support

`pay` URIs work with Freighter, Lobstr and other SEP-0007 wallets. `tx` URIs
work with wallets that support SEP-0007 `tx`. The copyable `pay` URI is always
offered as the fallback.

Generator fix included: `buildQRPaymentURI` now validates the asset issuer and
reports `Invalid destination address` / `Invalid asset issuer address`, which
its existing tests expected. The legacy QR on a share row now pays the
expense's payer instead of the debtor's own account.
