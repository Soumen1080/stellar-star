# Household Coordination Pilot: Success Metrics and Feedback Plan

**Status:** thresholds defined before pilot; no pilot results are claimed here.  
**Release gate:** this prototype must not be promoted to general availability
until a pilot report evaluates every metric below and product owners document
the decision.

## Pilot design

- Invite at least 30 consenting household trips with at least 3 members each.
- Run for at least 6 weeks, with an opt-in comparison cohort of similar trips
  that does not enable the chores module.
- Do not require members to participate. Record owner enablement, individual
  opt-outs, and withdrawals separately.
- Collect a baseline survey before use, a short weekly pulse, and an end-of-pilot
  interview. Report denominators and missing responses, not just percentages.
- Compare retention at the household-trip level using the same activity
  definition and observation period for both cohorts.

## Pre-registered success thresholds

| Measure | Definition | Threshold to pass |
|---|---|---|
| Activation | Enabled pilot trips that create at least one chore within 7 days | At least 60% |
| Repeat use | Activated trips with a chore completion in 4 or more distinct pilot weeks | At least 50% |
| Rotation fairness | Eligible members assigned a chore at least once in their observed rotation | At least 80% of participating members |
| Opt-out safety | Opt-out preference respected by the next eligible-assignee calculation and completion RPC | 100% in test cases and pilot audit |
| Retention signal | Difference in 6-week active-trip retention against comparison cohort | At least +5 percentage points; report confidence interval and do not claim causality from an underpowered sample |
| Perceived usefulness | Participants rating the module useful (4 or 5 on a 5-point scale) | At least 60% of respondents |
| Friction | Participants reporting confusion about how chores affect money | 0 unresolved reports; the feature must clearly say it does not affect balances |
| Financial isolation | Chore events associated with a change to expense shares, payment status, or calculated balances | Exactly 0 |

These are decision thresholds, not reported results. If the sample is too small
to estimate the retention difference responsibly, extend the pilot or report
the result as inconclusive rather than relaxing the threshold after seeing data.

## Feedback questions

1. Did the chore cadence and rotation reflect how your household actually
   shares recurring work?
2. Was it clear who was responsible and how to opt out?
3. Did an optional supply-expense link help connect coordination and shopping,
   without making chores feel like debts?
4. What made you stop using the module, or what prevented your household from
   enabling it?
5. Would you prefer chores to remain separate from expense balances?

## General-release decision

Publish the sample size, cohort definitions, completion and opt-out rates,
retention estimate with uncertainty, qualitative themes, and financial
isolation audit. General release requires every safety/usability measure to
pass, the retention result to meet threshold or be explicitly judged
inconclusive by product review, and a documented decision from the product
owner. A positive retention signal alone is insufficient.
