# Asset readiness before payment (#332)

The payment row now waits for a live readiness check on the connected wallet
and selected Stellar network. The panel shows spendable balance for the exact
canonical asset, the unpaid amount, a live network fee estimate (two operations
to cover payment and optional contract recording), native XLM available for
fees, reserve already locked, the sender trustline and issuer authorization,
and whether the recipient account is funded, authorized, and has enough
trustline capacity.

An explicit **Add trustline** action builds and submits a ChangeTrust only after
the user chooses it and signs. Its reserve cost is displayed; the operation is
not created automatically. Sponsored reserves are identified and spendable
balance already excludes reserves and liabilities. Network mismatch, unknown
network, untrusted asset/issuer, missing authorization, insufficient balance,
missing recipient capacity, and Horizon read failure all keep payment disabled.
Errors use actionable copy rather than raw Horizon responses.

The fee figure is an estimate based on current Horizon fee statistics and may
change before submission; the wallet still shows the final transaction for
review. `getAccountState` reads current ledger reserve parameters and trustline
flags, while per-asset balance calculations subtract selling liabilities.
