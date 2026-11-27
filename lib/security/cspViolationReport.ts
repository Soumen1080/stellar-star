/**
 * Node.js-only helpers for processing CSP reports.
 *
 * Keep this module out of middleware: middleware executes in the Edge runtime,
 * where Node's `crypto` module cannot be bundled.
 */

import crypto from "node:crypto";
import type { CSPViolationPayload, SanitizedCSPViolation } from "@/types/csp";

/** Sanitizes an incoming CSP violation report for persistent logging. */
export function sanitizeViolationReport(
  payload: CSPViolationPayload,
  clientIp?: string,
): SanitizedCSPViolation {
  const report = payload["csp-report"] || payload.body || {};
  const clientIpHash = clientIp
    ? crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 16)
    : undefined;

  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    documentUri: report["document-uri"] || payload.url,
    blockedUri: report["blocked-uri"],
    violatedDirective: report["violated-directive"],
    effectiveDirective: report["effective-directive"],
    sourceFile: report["source-file"],
    lineNumber: report["line-number"],
    columnNumber: report["column-number"],
    disposition: report.disposition,
    clientIpHash,
  };
}
