import {
  reportError,
  buildReport,
  setErrorReporter,
  redactSensitiveData,
} from "@/lib/observability/reportError";
import {
  evaluateAlertConditions,
  resetAlertHistory,
} from "@/lib/observability/alerts";

describe("reportError", () => {
  afterEach(() => {
    setErrorReporter(null);
    resetAlertHistory();
  });

  it("routes to a custom reporter when one is set", () => {
    const spy = jest.fn();
    setErrorReporter(spy);

    reportError("payment.failed", new Error("boom"), { amount: "3" });

    expect(spy).toHaveBeenCalledTimes(1);
    const report = spy.mock.calls[0][0];
    expect(report.name).toBe("payment.failed");
    expect(report.message).toBe("boom");
    expect(report.context).toEqual({ amount: "3" });
    expect(report.network).toBeDefined();
    expect(report.appVersion).toBeDefined();
    expect(report.timestamp).toBeDefined();
    expect(report.requestId).toBeDefined();
  });

  it("builds a structured report from varied error inputs", () => {
    const fromError = buildReport("a", new Error("e1"), { x: 1 });
    const fromString = buildReport("b", "plain string");

    expect(fromError.message).toBe("e1");
    expect(fromError.context).toEqual({ x: 1 });
    expect(fromString.message).toBe("plain string");
    expect(fromString.severity).toBe("error");
  });

  it("logs via console.error in node when no reporter and no window", () => {
    // jest testEnvironment is "node", so `window` is undefined and the default
    // sink is console.error — the failure must still be recorded somewhere.
    const ce = jest.spyOn(console, "error").mockImplementation(() => {});
    reportError("node.err", new Error("e"));
    expect(ce).toHaveBeenCalled();
    ce.mockRestore();
  });

  it("verifies the reporter receives a redacted event without secrets or XDR", () => {
    const spy = jest.fn();
    setErrorReporter(spy);

    const dummySecret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3FAC6WGSJAHQAQ2PBKF2642";
    const dummyJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const dummyXdr = "AAAAAgAAAABo1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ=";

    reportError(
      "payment.submission-failed",
      new Error(`Submission failed for signer ${dummySecret}`),
      {
        secretKey: dummySecret,
        nested: {
          token: dummyJwt,
          signedXdr: dummyXdr,
          txHash: "a1b2c3d4e5f6",
        },
        items: [
          { seed: "12345678" },
          dummySecret,
        ],
      },
      "error",
      "req-1234-abcd-5678-ef0123456789",
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const report = spy.mock.calls[0][0];

    // Check correlation ID
    expect(report.requestId).toBe("req-1234-abcd-5678-ef0123456789");

    // Check message sanitization
    expect(report.message).not.toContain(dummySecret);
    expect(report.message).toContain("[REDACTED_STELLAR_SECRET]");

    // Check context redaction
    const ctx = report.context as Record<string, any>;
    expect(ctx.secretKey).toBe("[REDACTED]");
    expect(ctx.nested.token).toBe("[REDACTED]");
    expect(ctx.nested.signedXdr).toBe("[REDACTED]");
    expect(ctx.nested.txHash).toBe("a1b2c3d4e5f6");
    expect(ctx.items[0].seed).toBe("[REDACTED]");
    expect(ctx.items[1]).toBe("[REDACTED_STELLAR_SECRET]");
  });

  it("evaluates SEV-1 alert on partial-success (funds moved without on-chain recording)", () => {
    const alert = evaluateAlertConditions({
      name: "payment.onchain-proof-failed",
      message: "The payment succeeded on Horizon but on-chain proof failed",
      context: {
        hash: "tx-abc-123",
        onChain: false,
      },
      requestId: "test-req-partial-1",
    });

    expect(alert).not.toBeNull();
    expect(alert?.type).toBe("PARTIAL_SUCCESS_SPIKE");
    expect(alert?.severity).toBe("SEV-1");
    expect(alert?.requestId).toBe("test-req-partial-1");
    expect(alert?.runbookUrl).toContain("docs/RUNBOOK.md#9");
    expect(alert?.investigationSteps.length).toBeGreaterThan(0);
  });

  it("evaluates SEV-1 alert on critical infrastructure outage", () => {
    const alert = evaluateAlertConditions({
      name: "payment.submission-failed",
      message: "fetch failed to Horizon gateway 504 Gateway Timeout",
      requestId: "test-req-outage-1",
    });

    expect(alert).not.toBeNull();
    expect(alert?.type).toBe("CRITICAL_SERVICE_UNAVAILABLE");
    expect(alert?.severity).toBe("SEV-1");
  });

  it("evaluates SEV-2 alert on repeated money-path failures within 5 minutes", () => {
    const r1 = evaluateAlertConditions({
      name: "payment.failed",
      message: "Transaction cancelled in wallet",
      requestId: "req-f1",
    });
    expect(r1).toBeNull(); // 1st failure, below threshold of 3

    const r2 = evaluateAlertConditions({
      name: "payment.failed",
      message: "Transaction sequence mismatch",
      requestId: "req-f2",
    });
    expect(r2).toBeNull(); // 2nd failure

    const r3 = evaluateAlertConditions({
      name: "payment.failed",
      message: "Transaction fee too low",
      requestId: "req-f3",
    });
    expect(r3).not.toBeNull(); // 3rd failure triggers SEV-2
    expect(r3?.type).toBe("REPEATED_FAILURES");
    expect(r3?.severity).toBe("SEV-2");
  });
});
