import { categorizeError } from "@/lib/observability/errorTaxonomy";
import { DatabaseError } from "@/lib/supabase/queries";

describe("Error Taxonomy & Categorization", () => {
  it("should categorize wallet rejections and cancel actions correctly", () => {
    const error1 = new Error("User rejected the transaction signature request");
    const error2 = new Error("Modal closed without selecting a wallet");
    const error3 = "user cancel";

    const res1 = categorizeError(error1);
    const res2 = categorizeError(error2);
    const res3 = categorizeError(error3);

    expect(res1.category).toBe("wallet_rejection");
    expect(res1.safeToRetry).toBe(true);

    expect(res2.category).toBe("wallet_rejection");
    expect(res2.safeToRetry).toBe(true);

    expect(res3.category).toBe("wallet_rejection");
    expect(res3.safeToRetry).toBe(true);
  });

  it("should categorize database setup errors (missing tables/PGRST205)", () => {
    const error = new DatabaseError("relation trips does not exist", "PGRST205");
    const res = categorizeError(error);

    expect(res.category).toBe("database_setup");
    expect(res.safeToRetry).toBe(false);
    expect(res.title).toBe("Database Setup Required");
  });

  it("should categorize database RLS / permission errors (42501)", () => {
    const error = new DatabaseError("new row violates row-level security policy for table expenses", "42501");
    const res = categorizeError(error);

    expect(res.category).toBe("permission_denied");
    expect(res.safeToRetry).toBe(false);
    expect(res.title).toBe("Access Denied");
  });

  it("should categorize ambiguous submission outcomes (no result codes / network failure)", () => {
    const error1 = new Error("submitTransaction timed out after 30 seconds");
    const error2 = new Error("Horizon request failed: 504 Gateway Timeout");
    const error3 = new Error("fetch failed during transaction submission");

    const res1 = categorizeError(error1);
    const res2 = categorizeError(error2);
    const res3 = categorizeError(error3);

    expect(res1.category).toBe("ambiguous_submission");
    expect(res1.safeToRetry).toBe(false);
    expect(res1.title).toBe("Payment Status Ambiguous");

    expect(res2.category).toBe("ambiguous_submission");
    expect(res2.safeToRetry).toBe(false);

    expect(res3.category).toBe("ambiguous_submission");
    expect(res3.safeToRetry).toBe(false);
  });

  it("should categorize definitive Stellar operation failures (specific result codes)", () => {
    const error1 = new Error("Operation failed: op_underfunded");
    const error2 = new Error("Transaction failed: tx_bad_seq");
    const error3 = new Error("Insufficient XLM balance to complete this payment");

    const res1 = categorizeError(error1);
    const res2 = categorizeError(error2);
    const res3 = categorizeError(error3);

    expect(res1.category).toBe("stellar_operation");
    expect(res1.safeToRetry).toBe(true);

    expect(res2.category).toBe("stellar_operation");
    expect(res2.safeToRetry).toBe(true);

    expect(res3.category).toBe("stellar_operation");
    expect(res3.safeToRetry).toBe(true);
  });

  it("should categorize general network errors", () => {
    const error = new Error("Failed to fetch");
    const res = categorizeError(error);

    expect(res.category).toBe("network_temporary");
    expect(res.safeToRetry).toBe(true);
    expect(res.title).toBe("Connection Lost");
  });

  it("should categorize unexpected generic errors", () => {
    const error = new Error("Something completely unknown happened");
    const res = categorizeError(error);

    expect(res.category).toBe("generic");
    expect(res.safeToRetry).toBe(true);
    expect(res.title).toBe("Something Went Wrong");
  });
});
