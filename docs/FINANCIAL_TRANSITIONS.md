# Financial transition model

Migration `0021_immutable_financial_transitions.sql` makes `expenses.shares` and
`expenses.settled` database controlled state. Direct authenticated table updates
to either field fail, even when row level security otherwise permits editing.
Settlement RPCs retain their row locks and execute through transaction-local
capabilities. Descriptive edits continue through `update_expense_versioned`.

An authorized expense manager can change a split through the versioned expense
edit or `record_financial_correction(expense_id, shares, reason)`. The database
validates unique share members, non-negative decimal values, exact conservation
against `total_amount`, and that `settled` agrees with all share payment states.
The versioned edit records a standard correction reason; explicit corrections
should use the correction RPC to provide a specific explanation.

Every accepted update to share balances appends a before/after snapshot to
`financial_transition_events`. Authenticated expense members can read the log;
clients cannot insert, update, or delete events. Existing dispute events remain
append-only and settlement installments remain idempotent by transaction hash.
Settlement intents retain immutable debt/idempotency fields, enforce an explicit
status graph, and append status or transaction hash changes to
`settlement_intent_events`; deletion is rejected.

Property coverage in `__tests__/property/financialTransitions.test.ts` exercises
concurrent installment contenders and asserts that accepted payments cannot
exceed the owed balance or count a retry hash twice. Apply migration 0021 before
deploying code that uses these guards.
