# Release evidence

Evidence envelopes consumed by the release readiness scorecard (#447). Each file is
`<name>.json` with `{ name, collectedAt, source, commit?, data }` and is created with
`npm run release:evidence`. CI generates `security-build`, `contracts`, `npm-audit` and
`restore-drill` during a promotion run. Owners commit `performance`, `slos`,
`backup-snapshot` and `rollback-plan` from production systems.

See [docs/RELEASE_READINESS_SCORECARD.md](../../docs/RELEASE_READINESS_SCORECARD.md).
