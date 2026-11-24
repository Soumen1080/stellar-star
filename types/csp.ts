/**
 * types/csp.ts
 *
 * Issue #457: Types for Content Security Policy, Nonces, and Violation Reports.
 */

export interface CSPReportBody {
  "document-uri"?: string;
  referrer?: string;
  "blocked-uri"?: string;
  "violated-directive"?: string;
  "effective-directive"?: string;
  "original-policy"?: string;
  disposition?: "enforce" | "report";
  "status-code"?: number;
  "script-sample"?: string;
  "source-file"?: string;
  "line-number"?: number;
  "column-number"?: number;
}

export interface CSPViolationPayload {
  "csp-report"?: CSPReportBody;
  // Reporting API v1 format
  type?: string;
  age?: number;
  url?: string;
  user_agent?: string;
  body?: CSPReportBody;
}

export interface SanitizedCSPViolation {
  id: string;
  timestamp: string;
  documentUri?: string;
  blockedUri?: string;
  violatedDirective?: string;
  effectiveDirective?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  disposition?: string;
  clientIpHash?: string;
}

export interface CSPOptions {
  nonce?: string;
  isDev?: boolean;
  reportUri?: string;
  additionalConnectOrigins?: string[];
  additionalScriptHashes?: string[];
}
