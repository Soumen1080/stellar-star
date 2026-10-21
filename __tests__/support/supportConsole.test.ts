/**
 * __tests__/support/supportConsole.test.ts
 *
 * Test suite for Issue #314: Create an incident-response and support console.
 *
 * Verifies:
 * 1. Automatic query type detection (tx_hash, wallet, trip_id, expense_id, correlation_id).
 * 2. Strict secret and credential redaction across all payloads (zero secret exposure).
 * 3. Immutable audit logging of every staff customer lookup.
 * 4. Dual-control (Four-Eyes Principle) enforcement for exceptional corrective actions.
 * 5. Network explorer URL resolution linking to the configured network.
 * 6. Read-only guardrails: Support console lookups are strictly non-mutating.
 */

import {
  detectQueryType,
  checkStaffAuthorization,
  recordSupportLookupAudit,
  fetchSupportAuditLogs,
  lookupIncident,
} from "@/lib/support/service";
import {
  redactSensitiveString,
  redactObject,
  maskQueryForAudit,
} from "@/lib/support/redact";
import {
  proposeCorrectiveAction,
  approveCorrectiveAction,
  rejectCorrectiveAction,
  listCorrectiveActions,
  DualControlError,
} from "@/lib/support/dualControl";
import { POST as lookupRoute } from "@/app/api/support/lookup/route";
import { GET as auditLogsRoute } from "@/app/api/support/audit-logs/route";
import { POST as proposeRoute } from "@/app/api/support/actions/propose/route";
import { POST as approveRoute } from "@/app/api/support/actions/approve/route";
import { NextRequest } from "next/server";

describe("Support Console & Incident Response (#314)", () => {
  const TEST_TX_HASH = "826092e11281bd8fe3c8997ef0a4886b1bd3728069c6855ec4e3866f0a8f9d06";
  const TEST_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7IRNVAXQIUI46G2XST4KSDUP";
  const TEST_SECRET_KEY = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // 56 chars S-prefixed
  const TEST_CORRELATION_ID = "req-93e1a821-4f01-49b2-9a88-29ef182a0b12";
  const TEST_EXPENSE_ID = "exp_88291a0b-1122-3344-5566-778899aabbcc";
  const TEST_TRIP_ID = "trip_44001122-3344-5566-7788-99aabbccddee";

  // ─── 1. QUERY TYPE DETECTION ─────────────────────────────────────────────────

  describe("Query Type Detection", () => {
    it("detects 64-hex strings as transaction hashes", () => {
      expect(detectQueryType(TEST_TX_HASH)).toBe("tx_hash");
      expect(detectQueryType(TEST_TX_HASH.toUpperCase())).toBe("tx_hash");
    });

    it("detects 56-character G-prefixed strings as Stellar wallet addresses", () => {
      expect(detectQueryType(TEST_WALLET)).toBe("wallet");
    });

    it("detects correlation / request IDs", () => {
      expect(detectQueryType(TEST_CORRELATION_ID)).toBe("correlation_id");
      expect(detectQueryType("req_session_12345")).toBe("correlation_id");
      expect(detectQueryType("corr-4491-a20")).toBe("correlation_id");
    });

    it("detects trip IDs", () => {
      expect(detectQueryType(TEST_TRIP_ID)).toBe("trip_id");
      expect(detectQueryType("trip-japan-2026")).toBe("trip_id");
    });

    it("detects expense IDs", () => {
      expect(detectQueryType(TEST_EXPENSE_ID)).toBe("expense_id");
      expect(detectQueryType("expense_dinner_01")).toBe("expense_id");
    });
  });

  // ─── 2. ZERO SECRET LEAKAGE / DATA REDACTION ────────────────────────────────

  describe("Zero Secret Leakage & Redaction Engine", () => {
    it("redacts Stellar secret keys (S... 56 chars) from strings", () => {
      const text = `User submitted transaction using secret ${TEST_SECRET_KEY} directly.`;
      const sanitized = redactSensitiveString(text);
      expect(sanitized).not.toContain(TEST_SECRET_KEY);
      expect(sanitized).toContain("[REDACTED_STELLAR_SECRET_KEY]");
    });

    it("redacts JWT tokens and Authorization Bearer headers", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature123";
      const bearer = `Authorization: Bearer ${jwt}`;
      const sanitized = redactSensitiveString(bearer);
      expect(sanitized).not.toContain("doNotLeakThisSignature123");
      expect(sanitized).toContain("[REDACTED_BEARER_TOKEN]");
    });

    it("deeply and recursively scrubs sensitive properties from objects", () => {
      const payload = {
        title: "Team Dinner",
        amount: "150.00",
        creator: TEST_WALLET,
        internal_auth: {
          secret_key: TEST_SECRET_KEY,
          jwt_token: "eyJhbGciOi.eyJzdWIi.signature",
          api_token: "stk_live_super_secret_9988",
        },
        metadata: {
          notes: `Check key ${TEST_SECRET_KEY}`,
          nestedArray: [{ password: "super_secret_password" }],
        },
      };

      const redacted = redactObject(payload);
      expect(redacted.title).toBe("Team Dinner");
      expect(redacted.creator).toBe(TEST_WALLET); // Public key preserved
      expect(redacted.internal_auth.secret_key).toBe("[REDACTED_SECRET]");
      expect(redacted.internal_auth.jwt_token).toBe("[REDACTED_SECRET]");
      expect(redacted.internal_auth.api_token).toBe("[REDACTED_SECRET]");
      expect(redacted.metadata.nestedArray[0].password).toBe("[REDACTED_SECRET]");
      expect(redacted.metadata.notes).not.toContain(TEST_SECRET_KEY);
    });

    it("safely masks search query values before recording to audit logs", () => {
      expect(maskQueryForAudit(TEST_WALLET)).toBe("GBZXN7...SDUP");
      expect(maskQueryForAudit(TEST_TX_HASH)).toBe("826092e1...f9d06");
      expect(maskQueryForAudit(TEST_SECRET_KEY)).toContain("S***[REDACTED_SECRET_KEY_");
      expect(maskQueryForAudit(TEST_SECRET_KEY)).not.toContain("SBXXXXXXXXXXXXXXXXX");
    });
  });

  // ─── 3. STAFF AUTHORIZATION & AUDIT LOGGING ──────────────────────────────────

  describe("Staff Authorization & Audit Logging", () => {
    it("records every staff lookup in the audit trail", async () => {
      const initialLogs = await fetchSupportAuditLogs(100);
      const initialCount = initialLogs.length;

      await recordSupportLookupAudit({
        staffIdentifier: "support-agent-alice",
        queryType: "tx_hash",
        queryValueMasked: TEST_TX_HASH,
        resultsCount: 1,
        ipAddress: "192.168.1.100",
        userAgent: "Jest-Test-Runner/1.0",
      });

      const updatedLogs = await fetchSupportAuditLogs(100);
      expect(updatedLogs.length).toBe(initialCount + 1);

      const latest = updatedLogs[0];
      expect(latest.staffIdentifier).toBe("support-agent-alice");
      expect(latest.queryType).toBe("tx_hash");
      expect(latest.queryValueMasked).toBe("826092e1...f9d06"); // Masked
      expect(latest.ipAddress).toBe("192.168.1.100");
    });
  });

  // ─── 4. DUAL-CONTROL (FOUR-EYES PRINCIPLE) PROCEDURES ────────────────────────

  describe("Dual-Control Corrective Action Procedure", () => {
    it("submits a new corrective proposal in pending_approval state", async () => {
      const proposal = await proposeCorrectiveAction({
        actionType: "MARK_INTENT_FAILED",
        targetId: "s0a80101-0000-4000-8000-000000000001",
        targetType: "intent",
        ticketRef: "INC-2026-1021",
        reason: "User wallet crashed during submission. Horizon confirms no transaction was broadcast.",
        proposedBy: "staff-agent-carol",
      });

      expect(proposal.id).toBeDefined();
      expect(proposal.status).toBe("pending_approval");
      expect(proposal.ticketRef).toBe("INC-2026-1021");
      expect(proposal.proposedBy).toBe("staff-agent-carol");
      expect(proposal.approvedBy).toBeUndefined();
    });

    it("rejects proposals without valid ticket reference or root-cause reason", async () => {
      await expect(
        proposeCorrectiveAction({
          actionType: "MARK_INTENT_FAILED",
          targetId: "intent-123",
          targetType: "intent",
          ticketRef: "",
          reason: "User asked nicely",
          proposedBy: "staff-agent-carol",
        })
      ).rejects.toThrow("valid support ticket reference");

      await expect(
        proposeCorrectiveAction({
          actionType: "MARK_INTENT_FAILED",
          targetId: "intent-123",
          targetType: "intent",
          ticketRef: "INC-1",
          reason: "too short",
          proposedBy: "staff-agent-carol",
        })
      ).rejects.toThrow("detailed justification");
    });

    it("STRICTLY BLOCKS self-approval (proposer === approver)", async () => {
      const proposal = await proposeCorrectiveAction({
        actionType: "FORCE_RECONCILE",
        targetId: "s0a80101-0000-4000-8000-000000000002",
        targetType: "intent",
        ticketRef: "INC-2026-8899",
        reason: "Network timeout delayed Supabase share settlement write.",
        proposedBy: "operator-dave",
      });

      // Attempting to self-approve with the same operator identity must fail
      await expect(
        approveCorrectiveAction(proposal.id, "operator-dave")
      ).rejects.toThrow(/Dual-Control Policy Violation: The proposer cannot approve their own corrective action/);

      // Status must remain pending_approval
      const actions = await listCorrectiveActions();
      const current = actions.find((a) => a.id === proposal.id);
      expect(current?.status).toBe("pending_approval");
    });

    it("allows approval by a DISTINCT secondary staff member (Staff A !== Staff B)", async () => {
      const proposal = await proposeCorrectiveAction({
        actionType: "FLAG_AMBIGUOUS_INVESTIGATION",
        targetId: "s0a80101-0000-4000-8000-000000000003",
        targetType: "intent",
        ticketRef: "INC-2026-9900",
        reason: "Mismatched memo on path payment requires financial engineering review.",
        proposedBy: "staff-agent-elena", // Staff A
      });

      // Staff B approves
      const approved = await approveCorrectiveAction(proposal.id, "lead-reviewer-marcus");

      expect(approved.status).toBe("executed");
      expect(approved.approvedBy).toBe("lead-reviewer-marcus");
      expect(approved.approvedAt).toBeDefined();
      expect(approved.executionResult).toBeDefined();
    });

    it("allows rejecting a corrective proposal with reason", async () => {
      const proposal = await proposeCorrectiveAction({
        actionType: "MARK_INTENT_FAILED",
        targetId: "s0a80101-0000-4000-8000-000000000004",
        targetType: "intent",
        ticketRef: "INC-2026-9911",
        reason: "Testing rejection flow",
        proposedBy: "staff-agent-carol",
      });

      const rejected = await rejectCorrectiveAction(
        proposal.id,
        "lead-reviewer-marcus",
        "Transaction is still pending in mempool; do not cancel yet."
      );

      expect(rejected.status).toBe("rejected");
      expect(rejected.executionResult?.rejectedBy).toBe("lead-reviewer-marcus");
    });
  });

  // ─── 5. READ-ONLY TIMELINE & EXPLORER URLS ───────────────────────────────────

  describe("Incident Lookup Engine & Explorer URLs", () => {
    it("returns read-only view with correct network explorer links", async () => {
      const incident = await lookupIncident({ query: TEST_TX_HASH, queryType: "tx_hash" });

      expect(incident.readOnly).toBe(true);
      expect(incident.detectedType).toBe("tx_hash");
      expect(incident.explorerLinks.networkName).toBeDefined();
      expect(incident.explorerLinks.txUrl).toContain(TEST_TX_HASH);
      expect(incident.redactedFields).toContain("private_keys");
    });
  });

  // ─── 6. API ROUTE ENDPOINTS ──────────────────────────────────────────────────

  describe("API Route Integration: /api/support/*", () => {
    it("rejects lookup with missing query with 400", async () => {
      const req = new NextRequest("http://localhost:3000/api/support/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "" }),
      });

      const res = await lookupRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("MISSING_QUERY");
    });

    it("performs lookup and records an audit log entry", async () => {
      const req = new NextRequest("http://localhost:3000/api/support/lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-staff-id": "test-agent-bob",
        },
        body: JSON.stringify({ query: TEST_CORRELATION_ID }),
      });

      const res = await lookupRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.readOnly).toBe(true);
      expect(json.data.detectedType).toBe("correlation_id");

      // Verify audit logs endpoint returns the access event
      const auditReq = new NextRequest("http://localhost:3000/api/support/audit-logs", {
        method: "GET",
      });
      const auditRes = await auditLogsRoute(auditReq);
      expect(auditRes.status).toBe(200);
      const auditJson = await auditRes.json();
      expect(auditJson.data.length).toBeGreaterThan(0);
    });

    it("propose route creates dual-control proposal", async () => {
      const req = new NextRequest("http://localhost:3000/api/support/actions/propose", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-staff-id": "staff-proposer-sam",
        },
        body: JSON.stringify({
          actionType: "MARK_INTENT_FAILED",
          targetId: "intent-api-test-01",
          targetType: "intent",
          ticketRef: "INC-2026-API-01",
          reason: "Testing API route submission of dual-control proposal.",
        }),
      });

      const res = await proposeRoute(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.status).toBe("pending_approval");
      expect(json.data.ticketRef).toBe("INC-2026-API-01");

      const proposalId = json.data.id;

      // Approving as SAME staff (staff-proposer-sam) must fail with 403
      const selfApproveReq = new NextRequest("http://localhost:3000/api/support/actions/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-staff-id": "staff-proposer-sam",
        },
        body: JSON.stringify({ proposalId, approverIdentifier: "staff-proposer-sam" }),
      });
      const selfApproveRes = await approveRoute(selfApproveReq);
      expect(selfApproveRes.status).toBe(403);
      const selfJson = await selfApproveRes.json();
      expect(selfJson.code).toBe("DUAL_CONTROL_SELF_APPROVAL_PROHIBITED");

      // Approving as DISTINCT staff (staff-approver-jen) must succeed with 200
      const distinctApproveReq = new NextRequest("http://localhost:3000/api/support/actions/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-staff-id": "staff-approver-jen",
        },
        body: JSON.stringify({ proposalId, approverIdentifier: "staff-approver-jen" }),
      });
      const distinctApproveRes = await approveRoute(distinctApproveReq);
      expect(distinctApproveRes.status).toBe(200);
      const distinctJson = await distinctApproveRes.json();
      expect(distinctJson.data.status).toBe("executed");
      expect(distinctJson.data.approvedBy).toBe("staff-approver-jen");
    });
  });
});
