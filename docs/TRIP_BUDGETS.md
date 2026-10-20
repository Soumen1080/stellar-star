# Trip budgets and spending alerts (#320)

A trip can have an optional overall budget, per-category caps, a display
currency, and alert thresholds (for example 50/80/100%). Budgets are only for
display. They never change amounts, shares, or settlement.

## The numbers

| Figure | Meaning |
|---|---|
| Committed | Saved expenses on the trip |
| Pending | Recurring drafts (#319) waiting for review. Drafts without an amount are counted separately and left out of the total. |
| Remaining | Budget − committed − pending |

## Assets are never mixed

Spend is grouped by **settlement asset** first, using `settlementAssetOf`. For
XLM-settled expenses:

- **Entered in the budget's currency:** the frozen creation-time snapshot
  (`totalAmount / exchangeRate`) is used, so the figure is exact.
- **Otherwise:** today's FX rate is used, and the figure is marked **≈**. The
  UI explains that it is approximate and shows how old the rate is.
- **No rate available:** the amount is listed separately as unconverted. It is
  never added at par.

Other settlement assets (for example USDC) are always listed separately in
their own asset.

## Alerts

- Each threshold crossing inserts one `budget_alerts` row. The partial unique
  index `(trip_id, scope, threshold) WHERE cleared_at IS NULL` ensures a
  crossing fires exactly once, even when several members' browsers evaluate it
  at the same moment.
- If spend drops back below a threshold (for example an expense is deleted),
  the alert is cleared, so the next crossing fires again.
- A member can mute alerts for a trip with the bell button. This is stored in
  `budget_alert_mutes`, and RLS only lets a member mute themselves. Muted
  members get no toasts or alert banner.
