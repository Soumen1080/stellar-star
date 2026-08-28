import {
  reportError,
  buildReport,
  setErrorReporter,
} from "@/lib/observability/reportError";

describe("reportError", () => {
  afterEach(() => setErrorReporter(null));

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
});
