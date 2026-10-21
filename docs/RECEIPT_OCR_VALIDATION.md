# Issue #340 validation record

Date: 2026-10-20. Base: `main` at `bf17401`.
Branch: `feat/340-receipt-ocr-drafts`.

## Acceptance coverage

| Requirement | Implementation and evidence |
|---|---|
| Explicit capture/selection and review before creation | Camera/file selection starts extraction. Merchant, date, total, currency and every item require confirmation; edits invalidate confirmation. Applying the draft and submitting the expense are separate actions. Browser tests cover the complete flow. |
| Original follows issue 014 | The unmodified file uses existing authenticated private storage, inspection, access and retention. Storage preflight runs before expense creation. Retry retains the expense ID and verifies duplicate checksums. Database tests verify membership isolation, denied client writes and orphan selection for retention. |
| Low confidence; no inferred total | Uncertain fields are visibly marked. Missing or ambiguous totals stay blank; items are never summed into a total. Tests cover ambiguity, invalid amounts, confirmation invalidation and confidence metadata. |
| Provider, regions, costs and terms reviewed before launch | RECEIPT_OCR.md records the engineering review and primary references. Pinned Tesseract assets run locally with bundled notices, no external OCR processor and an external OCR spend limit of zero. Original storage uses the existing Supabase processing arrangement. No live project region or organizational approval is invented. |

## Completed checks

- Strict production Next.js build: **exit 0**, including type checking, without E2E or security-scan bypass flags.
- Standalone TypeScript: **passed**.
- Full ESLint: **zero errors**, three existing warnings.
- Focused OCR, receipt, expense-form, schema and authentication checks: **184 tests passed in 24 suites**.
- Complete application browser flow: **3 passed**, covering desktop Chromium, Android/Pixel emulation and iOS/iPhone WebKit emulation. Real local Tesseract recognizes a synthetic image; backend/wallet fixtures isolate the environment. Tests verify mandatory review, edited-total reconfirmation, exact original SHA-256, storage failure recovery and one expense after retry.
- PostgreSQL/PGlite: **passed** against actual receipt SQL and policies, including private storage constraints, membership isolation, denied authenticated writes and deletion/retention linkage. Fresh cumulative setup and an upgrade with a historical migration-version collision both pass. Unique migration `0017_receipt_capture_prerequisites.sql` and cumulative setup are checked for repeat application.
- Production assets: **no injected E2E wallet seam**.
- OCR worker/core/model asset preparation and license notices: **passed**.
- `git diff --check`: **passed**.

The feature is enabled by default. Setting `NEXT_PUBLIC_RECEIPT_OCR_ENABLED=false`
and rebuilding disables it. Storage readiness fails closed before an expense can
be created from the receipt flow.

## Broader repository status and verification limits

The complete Jest audit reports **1,233 passed, 24 failed and 1 skipped tests**
across **130 passing, 11 failing and 1 skipped suites**. Remaining failures concern
trip mocks, payment/contract and trustline expectations, QR/money configuration,
unrelated historical schema collisions, governance approval records, production
configuration and reporter redaction expectations. All focused issue suites pass.
This record does not claim the entire repository test suite is green.

No deployment, live Supabase project or physical mobile camera was available.
Browser emulation and actual local SQL execution do not establish live credentials,
the deployed storage region, or operation of a hosted retention scheduler. Apply
the documented migration and configure existing receipt storage/retention when
deploying; the capability endpoint rejects unavailable storage. No production
deployment or external OCR service was created for this issue.

## Integration with updated upstream main

Upstream `31e04e4` was merged after the original validation above. The five
text conflicts were resolved, duplicate imports/state were removed, and the
receipt migration was moved from 0012 to **0017** because upstream now uses
0012 for installments. Historical prerequisite replay restores the latest 0016
granular permissions last; SQL checks assert the resulting receipt policy and
expense-link permission check.

After integration, **216 tests passed in 27 suites**, covering the receipt/OCR
checks and trip-form regressions. Actual SQL provisioning and repeatable upgrade
checks pass. The earlier production build and browser results describe the
pre-merge revision. The current upstream snapshot has TypeScript errors (120
diagnostics in a separate source snapshot); the merged branch has 70 diagnostics
in the incoming analytics, workspace, reminders and related code. Consequently,
the current integrated revision must not be described as passing the build gate.
The export suite also reports an upstream setup migration-marker mismatch.
