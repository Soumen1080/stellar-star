/**
 * lib/settlement/inflight.ts — single-flight registry.
 */

import { isInFlight, runOnce } from "@/lib/settlement/inflight";

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runOnce", () => {
  it("runs the work once and shares the result with concurrent callers", async () => {
    const gate = deferred<string>();
    const work = jest.fn(() => gate.promise);

    const first = runOnce("k", work);
    const second = runOnce("k", work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(isInFlight("k")).toBe(true);

    gate.resolve("done");
    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("keeps different keys independent", async () => {
    const work = jest.fn(async (value: string) => value);

    await expect(runOnce("a", () => work("a"))).resolves.toBe("a");
    await expect(runOnce("b", () => work("b"))).resolves.toBe("b");

    expect(work).toHaveBeenCalledTimes(2);
  });

  it("releases the key once the work resolves, allowing a later attempt", async () => {
    const work = jest.fn(async () => "ok");

    await runOnce("k", work);
    expect(isInFlight("k")).toBe(false);

    await runOnce("k", work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("releases the key once the work rejects, so a retry is not blocked", async () => {
    const failing = jest.fn(async () => {
      throw new Error("boom");
    });

    await expect(runOnce("k", failing)).rejects.toThrow("boom");
    expect(isInFlight("k")).toBe(false);

    await expect(runOnce("k", async () => "recovered")).resolves.toBe("recovered");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("shares a rejection with every concurrent caller", async () => {
    const gate = deferred<string>();
    const work = jest.fn(() => gate.promise);

    const first = runOnce("k", work);
    const second = runOnce("k", work);

    gate.reject(new Error("nope"));

    await expect(first).rejects.toThrow("nope");
    await expect(second).rejects.toThrow("nope");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("releases the key when the work throws synchronously", async () => {
    const throwing = jest.fn(() => {
      throw new Error("sync boom");
    });

    await expect(runOnce("k", throwing)).rejects.toThrow("sync boom");
    expect(isInFlight("k")).toBe(false);
  });

  it("never runs a queued caller twice when a new attempt starts after release", async () => {
    const work = jest.fn(async () => "value");

    await Promise.all([runOnce("k", work), runOnce("k", work)]);

    expect(work).toHaveBeenCalledTimes(1);
    expect(isInFlight("k")).toBe(false);
  });
});
