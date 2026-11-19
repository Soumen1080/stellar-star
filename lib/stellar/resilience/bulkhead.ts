/**
 * lib/stellar/resilience/bulkhead.ts
 *
 * Concurrency Bulkhead Pools for Stellar Dependency Classes (#426).
 *
 * Partitions worker concurrency into isolated compartments so that
 * a slow or failing dependency (e.g. Horizon reads) CANNOT consume all
 * server workers and starve unrelated operations (e.g. Soroban RPC or internal ops).
 */

import { BulkheadRejectedError } from "./errors";

export interface BulkheadConfig {
  maxConcurrent?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
}

export interface BulkheadMetrics {
  name: string;
  maxConcurrent: number;
  maxQueue: number;
  activeCount: number;
  queueCount: number;
  rejectedCount: number;
  completedCount: number;
}

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class BulkheadPool {
  readonly name: string;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly queueTimeoutMs: number;

  private active = 0;
  private queue: QueuedTask<any>[] = [];
  private totalRejected = 0;
  private totalCompleted = 0;

  constructor(name: string, config: BulkheadConfig = {}) {
    this.name = name;
    this.maxConcurrent = config.maxConcurrent ?? 20;
    this.maxQueue = config.maxQueue ?? 40;
    this.queueTimeoutMs = config.queueTimeoutMs ?? 5_000;
  }

  get activeCount(): number {
    return this.active;
  }

  get queueCount(): number {
    return this.queue.length;
  }

  get metrics(): BulkheadMetrics {
    return {
      name: this.name,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      activeCount: this.active,
      queueCount: this.queue.length,
      rejectedCount: this.totalRejected,
      completedCount: this.totalCompleted,
    };
  }

  /**
   * Executes a task within this bulkhead pool.
   * Rejects immediately if both active capacity and queue capacity are exhausted.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.runTask(fn);
    }

    if (this.queue.length >= this.maxQueue) {
      this.totalRejected++;
      throw new BulkheadRejectedError(
        this.name,
        this.maxConcurrent,
        this.maxQueue
      );
    }

    // Enqueue with timeout
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((item) => item.timer === timer);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.totalRejected++;
          reject(
            new BulkheadRejectedError(
              this.name,
              this.maxConcurrent,
              this.maxQueue
            )
          );
        }
      }, this.queueTimeoutMs);

      this.queue.push({ fn, resolve, reject, timer });
    });
  }

  private async runTask<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.totalCompleted++;
      return result;
    } finally {
      this.active--;
      this.drainNext();
    }
  }

  private drainNext(): void {
    if (this.active < this.maxConcurrent && this.queue.length > 0) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        clearTimeout(nextTask.timer);
        this.active++;
        this.runTask(nextTask.fn)
          .then(nextTask.resolve)
          .catch(nextTask.reject);
      }
    }
  }

  /**
   * Resets pool counters and clears pending queue for testing.
   */
  reset(): void {
    for (const item of this.queue) {
      clearTimeout(item.timer);
      item.reject(new Error(`Bulkhead pool '${this.name}' was reset.`));
    }
    this.queue = [];
    this.active = 0;
    this.totalRejected = 0;
    this.totalCompleted = 0;
  }
}
