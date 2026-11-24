/**
 * Types and interfaces for Provider Health Routing (#428).
 *
 * Implements health monitoring, ordered compatible fallbacks, and
 * strict consistency contracts across Stellar, FX, OCR, and Notification vendors.
 */

export type ProviderDomain = "stellar" | "fx" | "ocr" | "notification";

export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy" | "disabled";

export type ProviderCapability =
  // Stellar capabilities
  | "stellar:read"
  | "stellar:simulate"
  | "stellar:submit"
  // FX capabilities
  | "fx:crypto"
  | "fx:fiat"
  // OCR capabilities
  | "ocr:client"
  | "ocr:cloud"
  // Notification capabilities
  | "notification:email"
  | "notification:push"
  | "notification:webhook";

export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  message?: string;
  timestamp: number;
}

export interface ProviderRecord<T = any> {
  id: string;
  name: string;
  domain: ProviderDomain;
  priority: number; // lower number = higher priority (1 is primary, 2 is secondary, etc.)
  capabilities: ProviderCapability[];
  health: ProviderHealthStatus;
  disabled: boolean;
  lastHealthCheck?: HealthCheckResult;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalFailures: number;
  averageLatencyMs: number;
  endpointUrl?: string;
  client?: T;
  checkHealth: () => Promise<HealthCheckResult>;
}

export interface RouteExecutionOptions {
  domain: ProviderDomain;
  capability: ProviderCapability;
  idempotencyKey?: string;
  allowDegraded?: boolean;
  timeoutMs?: number;
  /**
   * For critical writes (e.g. payment submission), ensure consistency:
   * Failover must NOT blindly resubmit without verifying previous submission status!
   */
  requireSubmissionConsistency?: boolean;
  /**
   * Optional verification hook to check if the transaction already landed on chain
   * before falling over to a secondary provider.
   */
  verifyTxExists?: (txHashOrId: string) => Promise<boolean>;
  txHash?: string;
}

export interface ProviderHealthEvent {
  providerId: string;
  domain: ProviderDomain;
  previousStatus: ProviderHealthStatus;
  newStatus: ProviderHealthStatus;
  reason: string;
  timestamp: number;
}
