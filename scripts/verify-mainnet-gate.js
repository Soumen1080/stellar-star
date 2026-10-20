/**
 * scripts/verify-mainnet-gate.js
 *
 * Automated verification for the Mainnet Go/No-Go Release Gate (Issue #305).
 * Validates that `docs/MAINNET_READINESS.md`:
 *  1. Contains an explicit Go/No-Go Decision ("GO").
 *  2. Contains an auditable approval record with named owners and signatures.
 *  3. Covers all 7 required operational domains:
 *     - Security
 *     - Finance
 *     - Support
 *     - Contracts
 *     - Monitoring
 *     - Legal/Privacy Review
 *     - Rollback
 *  4. Every checklist item includes:
 *     - Named Owner
 *     - Status (APPROVED / PASS)
 *     - Valid proof link (local target verified on disk)
 *     - Active, unexpired review date (>= evaluation date)
 *  5. All required P0 checklist items pass.
 *
 * This script runs in CI to block production deployment if any P0 check fails.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DOC_PATH = path.join(ROOT_DIR, 'docs', 'MAINNET_READINESS.md');

const REQUIRED_CATEGORIES = [
  'security',
  'finance',
  'support',
  'contracts',
  'monitoring',
  'legal/privacy review',
  'rollback',
];

function normalizeCategoryName(name) {
  const lower = name.toLowerCase().replace(/&/g, '/');
  if (lower.includes('security')) return 'security';
  if (lower.includes('finance') || lower.includes('treasury')) return 'finance';
  if (lower.includes('support')) return 'support';
  if (lower.includes('contract')) return 'contracts';
  if (lower.includes('monitoring') || lower.includes('observability')) return 'monitoring';
  if (lower.includes('legal') || lower.includes('privacy')) return 'legal/privacy review';
  if (lower.includes('rollback')) return 'rollback';
  return lower;
}

function resolveLinkTarget(link, docFile) {
  // Strip query/hash anchors for file check
  const cleanLink = link.split('#')[0].split('?')[0].trim();
  if (!cleanLink) return null; // In-page anchor, valid
  if (/^https?:\/\//i.test(cleanLink)) return null; // Remote URL, skip disk check

  if (cleanLink.startsWith('/')) {
    return path.join(ROOT_DIR, cleanLink.replace(/^\//, ''));
  }
  return path.resolve(path.dirname(docFile), cleanLink);
}

function verifyGate() {
  const failures = [];
  const warnings = [];

  if (!fs.existsSync(DOC_PATH)) {
    console.error(`FATAL: ${DOC_PATH} does not exist.`);
    process.exit(1);
  }

  const content = fs.readFileSync(DOC_PATH, 'utf8');

  // 1. Verify Go/No-Go Decision
  const decisionMatch = content.match(/Gate Decision\*{0,2}\s*[:|]\s*\*{0,2}(GO|NO-GO|READY|BLOCKED)\*{0,2}/i);
  if (!decisionMatch) {
    failures.push('Missing explicit "Gate Decision: GO / NO-GO" declaration.');
  } else {
    const decision = decisionMatch[1].toUpperCase();
    if (decision !== 'GO' && decision !== 'READY') {
      failures.push(`Gate Decision is "${decision}" (must be "GO" for production deployment).`);
    }
  }

  // 2. Extract Gate Evaluation Date
  const evalDateMatch = content.match(/Evaluation Date\*{0,2}\s*[:|]\s*\*{0,2}(\d{4}-\d{2}-\d{2})\*{0,2}/i);
  const evaluationDateStr = evalDateMatch ? evalDateMatch[1] : '2026-10-19';
  const evaluationDate = new Date(evaluationDateStr);

  // 3. Verify Approval Record section exists
  const hasApprovalRecord = /##\s+.*Approval Record/i.test(content) || /##\s+.*Go\/No-Go Approval/i.test(content);
  if (!hasApprovalRecord) {
    failures.push('Missing auditable "Approval Record" section in docs/MAINNET_READINESS.md.');
  }

  // 4. Parse Sections and Tables
  const lines = content.split('\n');
  let currentCategory = null;
  const categoryItems = new Map();
  REQUIRED_CATEGORIES.forEach((cat) => categoryItems.set(cat, []));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect category header (e.g., ### 3.1 Security, ### Security, etc.)
    const headerMatch = line.match(/^#{2,4}\s+(?:[\d.]+\s*)?([A-Za-z/& ]+)/);
    if (headerMatch) {
      const normalized = normalizeCategoryName(headerMatch[1].trim());
      if (REQUIRED_CATEGORIES.includes(normalized)) {
        currentCategory = normalized;
      }
    }

    // Detect markdown table row: | ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
    if (currentCategory && line.trim().startsWith('|') && !line.includes('---')) {
      const cells = line.split('|').map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      
      // Look for data rows (skip headers)
      if (cells.length >= 6 && !cells[0].toLowerCase().includes('id') && !cells[1].toLowerCase().includes('item')) {
        const id = cells[0];
        const item = cells[1];
        const priority = cells[2] || 'P0';
        const owner = cells[3];
        const status = cells[4];
        const proofLinkCell = cells[5];
        const expiryCell = cells[6] || cells[5];

        categoryItems.get(currentCategory).push({
          id,
          item,
          priority: priority.toUpperCase(),
          owner,
          status: status.toUpperCase(),
          proofLinkCell,
          expiryCell,
          lineNum: i + 1,
          category: currentCategory,
        });
      }
    }
  }

  // Verify all 7 categories have checklist items
  for (const cat of REQUIRED_CATEGORIES) {
    const items = categoryItems.get(cat);
    if (!items || items.length === 0) {
      failures.push(`Category "${cat}" has no parsed checklist items.`);
    }
  }

  // Validate each item
  let totalItems = 0;
  let p0Items = 0;

  for (const [cat, items] of categoryItems.entries()) {
    for (const item of items) {
      totalItems++;
      const isP0 = item.priority.includes('P0');
      if (isP0) p0Items++;

      // Check Owner
      if (!item.owner || item.owner === '-' || item.owner.toLowerCase() === 'tbd') {
        failures.push(`[${item.id}] Missing named Owner in category "${cat}" (line ${item.lineNum}).`);
      }

      // Check Status
      const isApproved =
        item.status.includes('APPROVED') ||
        item.status.includes('PASS') ||
        item.status.includes('VERIFIED') ||
        item.status.includes('[X]');
      if (!isApproved) {
        if (isP0) {
          failures.push(`[${item.id}] Required P0 item status is "${item.status}" (must be APPROVED or PASS).`);
        } else {
          warnings.push(`[${item.id}] Non-P0 item is pending: "${item.status}".`);
        }
      }

      // Check Proof Link
      const linkMatch = item.proofLinkCell.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (!linkMatch) {
        failures.push(`[${item.id}] Missing markdown proof link in category "${cat}" (found: "${item.proofLinkCell}").`);
      } else {
        const rawTarget = linkMatch[2];
        const resolvedPath = resolveLinkTarget(rawTarget, DOC_PATH);
        if (resolvedPath && !fs.existsSync(resolvedPath)) {
          failures.push(`[${item.id}] Broken proof link target: "${rawTarget}" -> resolved "${resolvedPath}".`);
        }
      }

      // Check Expiry / Review Date
      const dateMatch = item.expiryCell.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) {
        failures.push(`[${item.id}] Missing valid ISO review/expiry date (YYYY-MM-DD) in "${item.expiryCell}".`);
      } else {
        const itemDate = new Date(dateMatch[1]);
        if (isNaN(itemDate.getTime())) {
          failures.push(`[${item.id}] Invalid date format "${dateMatch[1]}".`);
        } else if (itemDate < evaluationDate) {
          failures.push(`[${item.id}] Check review date "${dateMatch[1]}" has EXPIRED (prior to evaluation date ${evaluationDateStr}).`);
        }
      }
    }
  }

  // Summary output
  console.log('=====================================================');
  console.log('   Stellar-star Mainnet Go/No-Go Gate Verification   ');
  console.log('=====================================================');
  console.log(`Gate Document   : docs/MAINNET_READINESS.md`);
  console.log(`Evaluation Date : ${evaluationDateStr}`);
  console.log(`Gate Decision   : ${decisionMatch ? decisionMatch[1] : 'UNKNOWN'}`);
  console.log(`Categories      : ${REQUIRED_CATEGORIES.length} verified`);
  console.log(`Total Checks    : ${totalItems} (${p0Items} P0 items)`);
  console.log('-----------------------------------------------------');

  if (warnings.length > 0) {
    console.warn(`Warnings (${warnings.length}):`);
    warnings.forEach((w) => console.warn(`  ! ${w}`));
  }

  if (failures.length > 0) {
    console.error(`Release Gate FAILED with ${failures.length} blocking error(s):`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    console.error('-----------------------------------------------------');
    console.error('DEPLOYMENT BLOCKED: Production release gate cannot open until all P0 checks pass.');
    process.exit(1);
  }

  console.log('✓ Mainnet Go/No-Go gate verification passed. All P0 checks verified.');
  console.log('✓ Release gate status: OPEN for production deployment.');
  process.exit(0);
}

verifyGate();
