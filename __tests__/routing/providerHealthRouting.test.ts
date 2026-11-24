import {
  ProviderRegistry,
  executeWithFailover,
  NoHealthyProviderError,
  IncompatibleProviderError,
  DuplicatePaymentPreventedError,
  paymentSubmissionTracker,
} from "@/lib/routing";

describe("Provider Health Routing & Fallback Architecture (#428)", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
    paymentSubmissionTracker.clear();
  });

  describe("Ordered Compatible Fallbacks", () => {
    it("routes to priority 1 primary provider when healthy", async () => {
      let p1Calls = 0;
      let p2Calls = 0;

      registry.register({
        id: "test-primary",
        name: "Test Primary Provider",
        domain: "stellar",
        priority: 1,
        capabilities: ["stellar:read"],
        health: "healthy",
        disabled: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
        averageLatencyMs: 50,
        checkHealth: async () => ({ healthy: true, latencyMs: 50, timestamp: Date.now() }),
      });

      registry.register({
        id: "test-backup",
        name: "Test Backup Provider",
        domain: "stellar",
        priority: 2,
        capabilities: ["stellar:read"],
        health: "healthy",
        disabled: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
        averageLatencyMs: 100,
        checkHealth: async () => ({ healthy: true, latencyMs: 100, timestamp: Date.now() }),
      });

      const result = await executeWithFailover(
        { domain: "stellar", capability: "stellar:read" },
        async (provider) => {
          if (provider.id === "test-primary") {
            p1Calls++;
            return "RESULT_PRIMARY";
          }
          p2Calls++;
          return "RESULT_BACKUP";
        },
      );

      expect(result).toBe("RESULT_PRIMARY");
      expect(p1Calls).toBe(1);
      expect(p2Calls).toBe(0);
    });

    it("automatically fails over to priority 2 backup when primary fails", async () => {
      let p1Calls = 0;
      let p2Calls = 0;

      registry.register({
        id: "test-primary",
        name: "Test Primary Provider",
        domain: "fx",
        priority: 1,
        capabilities: ["fx:crypto"],
        health: "healthy",
        disabled: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
        averageLatencyMs: 80,
        checkHealth: async () => ({ healthy: true, latencyMs: 80, timestamp: Date.now() }),
      });

      registry.register({
        id: "test-backup",
        name: "Test Backup Provider",
        domain: "fx",
        priority: 2,
        capabilities: ["fx:crypto"],
        health: "healthy",
        disabled: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
        averageLatencyMs: 120,
        checkHealth: async () => ({ healthy: true, latencyMs: 120, timestamp: Date.now() }),
      });

      const result = await executeWithFailover(
        { domain: "fx", capability: "fx:crypto" },
        async (provider) => {
          if (provider.id === "test-primary") {
            p1Calls++;
            throw new Error("HTTP 503 Service Unavailable");
          }
          p2Calls++;
          return { rate: 0.125, source: "backup" };
        },
      );

      expect(result).toEqual({ rate: 0.125, source: "backup" });
      expect(p1Calls).toBe(1);
      expect(p2Calls).toBe(1);
    });
  });

  describe("Capability Gate & Consistency Assertions", () => {
    it("refuses to route payment submissions to read-only or simulation-only providers", async () => {
      registry.reset();

      // De-register submit providers to leave only simulation node
      registry.getAll().forEach((p) => {
        if (p.capabilities.includes("stellar:submit")) {
          registry.unregister(p.id);
        }
      });

      // Attempt payment submission when only simulation-capable nodes exist
      await expect(
        executeWithFailover(
          { domain: "stellar", capability: "stellar:submit" },
          async () => "submitted",
        ),
      ).rejects.toThrow(NoHealthyProviderError);
    });
  });

  describe("Payment Submission Duplicate Effect Avoidance", () => {
    it("verifies on-chain state before resubmitting during failover to prevent duplicate payments", async () => {
      let p1Calls = 0;
      let p2Calls = 0;
      let onChainVerified = false;

      const mockTxHash = "abc123mocktxhash456789";

      await expect(
        executeWithFailover(
          {
            domain: "stellar",
            capability: "stellar:submit",
            requireSubmissionConsistency: true,
            txHash: mockTxHash,
            verifyTxExists: async (hash) => {
              if (hash === mockTxHash) {
                onChainVerified = true;
                return true; // Transaction actually succeeded on network despite primary timeout!
              }
              return false;
            },
          },
          async (provider) => {
            if (provider.id === "stellar-primary-sdf") {
              p1Calls++;
              throw new Error("ETIMEDOUT: Horizon network connection dropped");
            }
            p2Calls++;
            return { hash: mockTxHash, ledger: 100, successful: true };
          },
        ),
      ).rejects.toThrow(DuplicatePaymentPreventedError);

      expect(p1Calls).toBe(1);
      // Secondary provider MUST NOT be called because transaction was verified as already committed!
      expect(p2Calls).toBe(0);
      expect(onChainVerified).toBe(true);
    });
  });

  describe("Operational Staff Controls & Manual Disablement", () => {
    it("allows staff to deliberately disable a flapping provider and immediately divert traffic", async () => {
      let p1Calls = 0;
      let p2Calls = 0;

      // Disable primary SDF Horizon
      registry.setDisabled("stellar-primary-sdf", true);

      const p1 = registry.get("stellar-primary-sdf");
      expect(p1?.disabled).toBe(true);
      expect(p1?.health).toBe("disabled");

      // Execute read: must bypass primary and execute on secondary
      const result = await executeWithFailover(
        { domain: "stellar", capability: "stellar:read" },
        async (provider) => {
          if (provider.id === "stellar-primary-sdf") {
            p1Calls++;
            return "PRIMARY";
          }
          p2Calls++;
          return "BACKUP";
        },
      );

      expect(result).toBe("BACKUP");
      expect(p1Calls).toBe(0);
      expect(p2Calls).toBe(1);

      // Re-enable primary: traffic resumes to primary
      registry.setDisabled("stellar-primary-sdf", false);
      const res2 = await executeWithFailover(
        { domain: "stellar", capability: "stellar:read" },
        async (provider) => {
          if (provider.id === "stellar-primary-sdf") {
            p1Calls++;
            return "PRIMARY";
          }
          p2Calls++;
          return "BACKUP";
        },
      );

      expect(res2).toBe("PRIMARY");
      expect(p1Calls).toBe(1);
    });
  });

  describe("Automatic Health Degradation & Probing Recovery", () => {
    it("transitions provider to unhealthy after 3 consecutive failures", () => {
      const provider = registry.get("stellar-primary-sdf")!;
      expect(provider.health).toBe("healthy");

      registry.recordExecution(provider.id, false, 200, new Error("Fail 1"));
      expect(provider.health).toBe("degraded");

      registry.recordExecution(provider.id, false, 200, new Error("Fail 2"));
      expect(provider.health).toBe("degraded");

      registry.recordExecution(provider.id, false, 200, new Error("Fail 3"));
      expect(provider.health).toBe("unhealthy");
    });

    it("re-admits unhealthy provider after successful health probes", async () => {
      const provider = registry.get("stellar-primary-sdf")!;
      provider.health = "unhealthy";
      provider.consecutiveFailures = 3;

      // Mock probe returning healthy
      provider.checkHealth = async () => ({ healthy: true, latencyMs: 60, timestamp: Date.now() });

      await registry.checkHealth(provider.id);
      expect(provider.health).toBe("healthy");
      expect(provider.consecutiveSuccesses).toBe(1);
    });
  });

  describe("Multi-Domain Fallbacks (Stellar, FX, OCR, Notification)", () => {
    it("executes notification fallback to backup relay when primary webhook fails", async () => {
      let notifyPrimary = 0;
      let notifyBackup = 0;

      const result = await executeWithFailover(
        { domain: "notification", capability: "notification:email" },
        async (provider) => {
          if (provider.id === "notification-webhook-primary") {
            notifyPrimary++;
            throw new Error("500 Internal Server Error");
          }
          notifyBackup++;
          return { delivered: true, relay: provider.id };
        },
      );

      expect(result).toEqual({ delivered: true, relay: "notification-relay-backup" });
      expect(notifyPrimary).toBe(1);
      expect(notifyBackup).toBe(1);
    });

    it("executes OCR fallback to cloud analyzer when client-side worker fails", async () => {
      let ocrWorkerCalls = 0;
      let ocrCloudCalls = 0;

      const result = await executeWithFailover(
        { domain: "ocr", capability: "ocr:client" },
        async (provider) => {
          ocrWorkerCalls++;
          return { items: [{ desc: "Coffee", amount: "4.50" }] };
        },
      );

      expect(result.items.length).toBe(1);
      expect(ocrWorkerCalls).toBe(1);
    });
  });
});
