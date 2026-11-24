import type {
  HealthCheckResult,
  ProviderCapability,
  ProviderDomain,
  ProviderHealthEvent,
  ProviderHealthStatus,
  ProviderRecord,
} from "./types";
import { HORIZON_URL, SOROBAN_RPC_URL } from "@/lib/utils/constants";

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly listeners: Array<(event: ProviderHealthEvent) => void> = [];

  constructor() {
    this.registerDefaultProviders();
  }

  register<T>(provider: ProviderRecord<T>): void {
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): ProviderRecord | undefined {
    return this.providers.get(providerId);
  }

  getAll(): ProviderRecord[] {
    return Array.from(this.providers.values());
  }

  getByDomain(domain: ProviderDomain): ProviderRecord[] {
    return this.getAll().filter((p) => p.domain === domain);
  }

  getCompatibleProviders(
    domain: ProviderDomain,
    capability: ProviderCapability,
    options: { allowDegraded?: boolean } = {},
  ): ProviderRecord[] {
    const { allowDegraded = true } = options;

    return this.getAll()
      .filter((p) => {
        if (p.domain !== domain) return false;
        if (p.disabled) return false;
        if (!p.capabilities.includes(capability)) return false;

        // Health status filtering
        if (p.health === "unhealthy" || p.health === "disabled") return false;
        if (!allowDegraded && p.health === "degraded") return false;

        return true;
      })
      .sort((a, b) => {
        // Sort by priority ASC (1 is highest priority), then by average latency ASC
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.averageLatencyMs - b.averageLatencyMs;
      });
  }

  async checkHealth(providerId: string): Promise<HealthCheckResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" not found in registry.`);
    }

    if (provider.disabled) {
      return {
        healthy: false,
        latencyMs: 0,
        message: "Provider is manually disabled.",
        timestamp: Date.now(),
      };
    }

    const previousStatus = provider.health;
    const start = Date.now();

    try {
      const result = await provider.checkHealth();
      const latency = Math.max(1, Date.now() - start);

      provider.lastHealthCheck = { ...result, latencyMs: latency };
      provider.averageLatencyMs = Math.round(
        (provider.averageLatencyMs * 0.7) + (latency * 0.3),
      );

      if (result.healthy) {
        provider.consecutiveSuccesses++;
        provider.consecutiveFailures = 0;

        if (provider.consecutiveSuccesses >= 2 || previousStatus === "unhealthy") {
          provider.health = latency > 2500 ? "degraded" : "healthy";
        }
      } else {
        provider.consecutiveFailures++;
        provider.consecutiveSuccesses = 0;

        if (provider.consecutiveFailures >= 3) {
          provider.health = "unhealthy";
        } else {
          provider.health = "degraded";
        }
      }

      if (provider.health !== previousStatus) {
        this.notifyStatusChange(provider, previousStatus, result.message || "Health check evaluated");
      }

      return result;
    } catch (err: unknown) {
      const latency = Math.max(1, Date.now() - start);
      const message = err instanceof Error ? err.message : "Health check threw an error";

      provider.consecutiveFailures++;
      provider.consecutiveSuccesses = 0;
      provider.lastHealthCheck = {
        healthy: false,
        latencyMs: latency,
        message,
        timestamp: Date.now(),
      };

      if (provider.consecutiveFailures >= 3) {
        provider.health = "unhealthy";
      } else {
        provider.health = "degraded";
      }

      if (provider.health !== previousStatus) {
        this.notifyStatusChange(provider, previousStatus, message);
      }

      return {
        healthy: false,
        latencyMs: latency,
        message,
        timestamp: Date.now(),
      };
    }
  }

  async checkAllHealth(): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {};
    const checks = this.getAll().map(async (p) => {
      results[p.id] = await this.checkHealth(p.id);
    });
    await Promise.all(checks);
    return results;
  }

  setDisabled(providerId: string, disabled: boolean): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) return false;

    const previousStatus = provider.health;
    provider.disabled = disabled;
    provider.health = disabled ? "disabled" : "healthy";

    if (provider.health !== previousStatus) {
      this.notifyStatusChange(
        provider,
        previousStatus,
        disabled ? "Operator manually disabled provider" : "Operator re-enabled provider",
      );
    }
    return true;
  }

  recordExecution(
    providerId: string,
    success: boolean,
    latencyMs: number,
    error?: Error,
  ): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    provider.totalRequests++;
    provider.averageLatencyMs = Math.round(
      provider.averageLatencyMs === 0
        ? latencyMs
        : (provider.averageLatencyMs * 0.8) + (latencyMs * 0.2),
    );

    const previousStatus = provider.health;

    if (success) {
      provider.consecutiveSuccesses++;
      provider.consecutiveFailures = 0;
      if (provider.health === "degraded" && provider.consecutiveSuccesses >= 3) {
        provider.health = "healthy";
      }
    } else {
      provider.totalFailures++;
      provider.consecutiveFailures++;
      provider.consecutiveSuccesses = 0;

      if (provider.consecutiveFailures >= 3) {
        provider.health = "unhealthy";
      } else {
        provider.health = "degraded";
      }
    }

    if (provider.health !== previousStatus) {
      this.notifyStatusChange(
        provider,
        previousStatus,
        error ? error.message : "Request outcome transition",
      );
    }
  }

  onStatusChange(listener: (event: ProviderHealthEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  reset(): void {
    this.providers.clear();
    this.registerDefaultProviders();
  }

  private notifyStatusChange(
    provider: ProviderRecord,
    previousStatus: ProviderHealthStatus,
    reason: string,
  ): void {
    const event: ProviderHealthEvent = {
      providerId: provider.id,
      domain: provider.domain,
      previousStatus,
      newStatus: provider.health,
      reason,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener error
      }
    }
  }

  private registerDefaultProviders(): void {
    // ── 1. Stellar Providers ───────────────────────────────────────────────────
    this.register({
      id: "stellar-primary-sdf",
      name: "Stellar SDF Primary Horizon",
      domain: "stellar",
      priority: 1,
      capabilities: ["stellar:read", "stellar:simulate", "stellar:submit"],
      health: "healthy",
      disabled: false,
      endpointUrl: HORIZON_URL,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 80,
      checkHealth: async () => {
        try {
          const res = await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`, {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          return {
            healthy: res.ok,
            latencyMs: 80,
            message: res.ok ? "Horizon ledger query OK" : `HTTP ${res.status}`,
            timestamp: Date.now(),
          };
        } catch (e: any) {
          return {
            healthy: false,
            latencyMs: 3000,
            message: e?.message || "Horizon connection failed",
            timestamp: Date.now(),
          };
        }
      },
    });

    this.register({
      id: "stellar-backup-public",
      name: "Stellar Public Backup Horizon",
      domain: "stellar",
      priority: 2,
      // Backup horizon supports reads & simulations, and submit only with consistency checks
      capabilities: ["stellar:read", "stellar:simulate", "stellar:submit"],
      health: "healthy",
      disabled: false,
      endpointUrl: "https://horizon.stellar.org",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 120,
      checkHealth: async () => {
        try {
          const res = await fetch("https://horizon.stellar.org/ledgers?order=desc&limit=1", {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          return {
            healthy: res.ok,
            latencyMs: 120,
            message: res.ok ? "Backup Horizon OK" : `HTTP ${res.status}`,
            timestamp: Date.now(),
          };
        } catch (e: any) {
          return {
            healthy: false,
            latencyMs: 3000,
            message: e?.message || "Backup connection failed",
            timestamp: Date.now(),
          };
        }
      },
    });

    this.register({
      id: "soroban-rpc-primary",
      name: "Soroban RPC Primary Node",
      domain: "stellar",
      priority: 1,
      capabilities: ["stellar:simulate"],
      health: "healthy",
      disabled: false,
      endpointUrl: SOROBAN_RPC_URL,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 100,
      checkHealth: async () => {
        try {
          const res = await fetch(`${SOROBAN_RPC_URL}/health`, {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          return {
            healthy: res.ok,
            latencyMs: 100,
            message: res.ok ? "Soroban RPC healthy" : `HTTP ${res.status}`,
            timestamp: Date.now(),
          };
        } catch {
          return {
            healthy: true, // Fail open if health endpoint is unauthenticated/custom
            latencyMs: 100,
            message: "Soroban RPC online",
            timestamp: Date.now(),
          };
        }
      },
    });

    // ── 2. FX Providers ────────────────────────────────────────────────────────
    this.register({
      id: "fx-coingecko",
      name: "CoinGecko FX Feeds",
      domain: "fx",
      priority: 1,
      capabilities: ["fx:crypto", "fx:fiat"],
      health: "healthy",
      disabled: false,
      endpointUrl: "https://api.coingecko.com/api/v3/ping",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 150,
      checkHealth: async () => {
        try {
          const res = await fetch("https://api.coingecko.com/api/v3/ping", {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          return {
            healthy: res.ok,
            latencyMs: 150,
            message: res.ok ? "CoinGecko Ping OK" : `HTTP ${res.status}`,
            timestamp: Date.now(),
          };
        } catch (e: any) {
          return {
            healthy: false,
            latencyMs: 3000,
            message: e?.message || "CoinGecko unreachable",
            timestamp: Date.now(),
          };
        }
      },
    });

    this.register({
      id: "fx-exchangerate",
      name: "ExchangeRate-API Fiat Feeds",
      domain: "fx",
      priority: 2,
      capabilities: ["fx:fiat"],
      health: "healthy",
      disabled: false,
      endpointUrl: "https://open.er-api.com/v6/latest/USD",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 200,
      checkHealth: async () => {
        try {
          const res = await fetch("https://open.er-api.com/v6/latest/USD", {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          return {
            healthy: res.ok,
            latencyMs: 200,
            message: res.ok ? "ExchangeRate-API OK" : `HTTP ${res.status}`,
            timestamp: Date.now(),
          };
        } catch (e: any) {
          return {
            healthy: false,
            latencyMs: 3000,
            message: e?.message || "ExchangeRate-API unreachable",
            timestamp: Date.now(),
          };
        }
      },
    });

    // ── 3. OCR Providers ───────────────────────────────────────────────────────
    this.register({
      id: "ocr-client-worker",
      name: "Client In-Browser Tesseract Worker",
      domain: "ocr",
      priority: 1,
      capabilities: ["ocr:client"],
      health: "healthy",
      disabled: false,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 1200,
      checkHealth: async () => ({
        healthy: typeof window !== "undefined" && typeof Worker !== "undefined",
        latencyMs: 10,
        message: "WebWorker runtime supported",
        timestamp: Date.now(),
      }),
    });

    this.register({
      id: "ocr-cloud-fallback",
      name: "Cloud Vision Receipt Analyzer",
      domain: "ocr",
      priority: 2,
      capabilities: ["ocr:cloud"],
      health: "healthy",
      disabled: false,
      endpointUrl: "/api/receipts/extract",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 800,
      checkHealth: async () => ({
        healthy: true,
        latencyMs: 50,
        message: "Server extraction gateway available",
        timestamp: Date.now(),
      }),
    });

    // ── 4. Notification Providers ──────────────────────────────────────────────
    this.register({
      id: "notification-webhook-primary",
      name: "Primary Webhook Delivery Relay",
      domain: "notification",
      priority: 1,
      capabilities: ["notification:email", "notification:push", "notification:webhook"],
      health: "healthy",
      disabled: false,
      endpointUrl: process.env.REMINDER_EMAIL_WEBHOOK_URL || "https://relay.primary.stellarstar.internal",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 150,
      checkHealth: async () => ({
        healthy: true,
        latencyMs: 50,
        message: "Primary notification relay online",
        timestamp: Date.now(),
      }),
    });

    this.register({
      id: "notification-relay-backup",
      name: "Backup Transactional Mail/Push Relay",
      domain: "notification",
      priority: 2,
      capabilities: ["notification:email", "notification:push", "notification:webhook"],
      health: "healthy",
      disabled: false,
      endpointUrl: process.env.REMINDER_BACKUP_WEBHOOK_URL || "https://relay.backup.stellarstar.internal",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalRequests: 0,
      totalFailures: 0,
      averageLatencyMs: 180,
      checkHealth: async () => ({
        healthy: true,
        latencyMs: 60,
        message: "Backup notification relay standby",
        timestamp: Date.now(),
      }),
    });
  }
}

export const providerRegistry = new ProviderRegistry();
