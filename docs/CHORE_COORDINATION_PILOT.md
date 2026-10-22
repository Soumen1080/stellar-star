# Chore Coordination Research Pilot

Chore coordination is an optional, off-chain research prototype inside the trip
workspace. It is not part of expense splitting, payment, or settlement. A linked
supply expense is a reference to an existing expense; completing a chore never
creates an expense, changes a share, or changes a balance.

## Pilot scope

- Run with invited flatmate groups for at least six weeks.
- Participation is opt-in per member; the trip owner can disable chores for the
  whole trip at any time.
- Keep the pilot behind the workspace chores tab. Do not include it in
  onboarding, templates, or default trip creation until the release gate below
  is met.
- Collect only the operational measures below and voluntary end-of-pilot
  feedback. Do not infer household relationships or collect chore details for
  unrelated analytics.

## Success measures and release gate

Set these thresholds before reviewing pilot outcomes:

1. **Retention signal (primary):** at least a 10 percentage-point improvement
   in week-four trip activity for groups that opt into chores, compared with a
   contemporaneous, similarly recruited group that does not use chores. Report
   group counts and uncertainty; do not claim a retention effect if fewer than
   20 groups per cohort complete the four-week observation.
2. **Repeated use:** at least 50% of chores created in the pilot have completion
   activity in three or more distinct recurrence periods.
3. **Voluntary adoption:** fewer than 25% of participating members opt out or
   request that the owner disable chores during the pilot.
4. **Member feedback:** at least 70% of responding participants rate the
   feature useful (4 or 5 on a 5-point scale), with feedback from at least half
   of participating groups.
5. **Financial isolation (hard guardrail):** zero chore actions alter expense
   rows, shares, payment records, or calculated balances. Any violation stops
   the pilot and blocks release.

A general release requires meeting the financial-isolation guardrail, meeting
the feedback threshold, and either meeting both quantitative usage/retention
thresholds or documenting why the pilot was underpowered and repeating it. An
owner-disable rate or recurring qualitative complaint about unfair rotation is
a stop-and-revise signal even if the other metrics pass.

## Pilot feedback questions

Ask participants whether rotation felt fair, whether recurrence timing matched
their household, whether opting out and owner disable were clear, whether
expense links were useful without implying payment, and what should change
before a broader release. Review responses before deciding on the thresholds
for any subsequent pilot; do not silently relax these release gates.

## Data boundary

Chore definitions, cadence, rotation member IDs, completion history, opt-out
preferences, and the enabled flag are stored in the existing off-chain trip
workspace. The only finance reference is an optional existing expense ID.
Amounts, shares, payment state, and settlement fields are not copied into chore
records. Workspace export and deletion include chore data.
