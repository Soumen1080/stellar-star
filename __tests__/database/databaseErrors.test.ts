/**
 * __tests__/database/databaseErrors.test.ts
 *
 * Verification of error translation for database timeouts, statement deadlines,
 * and lock contention (#421).
 */

import {
  toDatabaseError,
  PG_STATEMENT_TIMEOUT,
  PG_LOCK_NOT_AVAILABLE,
  PG_IDLE_IN_TRANSACTION_TIMEOUT,
  PG_SCHEMA_CACHE_MISS,
  PG_UNIQUE_VIOLATION,
  DatabaseError,
} from "@/lib/supabase/queries";
import { categorizeError } from "@/lib/observability/errorTaxonomy";
import type { PostgrestError } from "@supabase/supabase-js";

describe("Database Error Translation & Taxonomy", () => {
  it("translates statement_timeout (57014) to safe user-friendly message", () => {
    const pgError = {
      message: "canceling statement due to statement timeout",
      details: "",
      hint: "",
      code: PG_STATEMENT_TIMEOUT,
    } as unknown as PostgrestError;

    const err = toDatabaseError(pgError, "fetch trip history");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.code).toBe(PG_STATEMENT_TIMEOUT);
    expect(err.message).toContain("took too long to execute and was terminated");
  });

  it("translates lock_timeout (55P03) to safe retry message", () => {
    const pgError = {
      message: "canceling statement due to lock timeout",
      details: "could not obtain lock on relation trips",
      hint: "",
      code: PG_LOCK_NOT_AVAILABLE,
    } as unknown as PostgrestError;

    const err = toDatabaseError(pgError, "update expense");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.code).toBe(PG_LOCK_NOT_AVAILABLE);
    expect(err.message).toContain("currently locked by another concurrent operation");
  });

  it("translates idle_in_transaction_session_timeout (25P03) to timeout message", () => {
    const pgError = {
      message: "terminating connection due to idle-in-transaction timeout",
      details: "",
      hint: "",
      code: PG_IDLE_IN_TRANSACTION_TIMEOUT,
    } as unknown as PostgrestError;

    const err = toDatabaseError(pgError, "complete settlement");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.code).toBe(PG_IDLE_IN_TRANSACTION_TIMEOUT);
    expect(err.message).toContain("idle for too long and timed out");
  });

  it("categorizes database timeout as safe-to-retry temporary failure in error taxonomy", () => {
    const dbErr = new DatabaseError("canceling statement due to statement timeout", "57014");
    const categorized = categorizeError(dbErr);

    expect(categorized.category).toBe("network_temporary");
    expect(categorized.safeToRetry).toBe(true);
    expect(categorized.title).toBe("Database Operation Timed Out");
  });
});
