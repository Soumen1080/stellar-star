import { DatabaseError } from "@/lib/supabase/queries";

export type ErrorCategory =
  | "wallet_rejection"
  | "ambiguous_submission"
  | "database_setup"
  | "permission_denied"
  | "stellar_operation"
  | "network_temporary"
  | "generic";

export interface CategorizedError {
  category: ErrorCategory;
  title: string;
  copy: string;
  safeToRetry: boolean;
  originalError: unknown;
}

export function categorizeError(err: unknown): CategorizedError {
  const message = err instanceof Error ? err.message : String(err);
  const lowerMessage = message.toLowerCase();

  // 1. Wallet Rejection (User cancels or rejects in wallet modal/extension)
  if (
    /reject|cancel|deny|denied|dismiss|user closed/i.test(lowerMessage) ||
    lowerMessage.includes("modal closed")
  ) {
    return {
      category: "wallet_rejection",
      title: "Transaction Cancelled",
      copy: "The transaction request was cancelled in your wallet. If you want to proceed, you can safely try signing again.",
      safeToRetry: true,
      originalError: err,
    };
  }

  // 2. Database Setup / Missing Table (PGRST205)
  if (
    err instanceof DatabaseError &&
    (err.code === "PGRST205" || /schema cache/i.test(message) || /relation .* does not exist/i.test(message))
  ) {
    return {
      category: "database_setup",
      title: "Database Setup Required",
      copy: "The database tables are missing or outdated. If you are the administrator, please run supabase-setup.sql in the Supabase SQL Editor.",
      safeToRetry: false,
      originalError: err,
    };
  }

  // 3. Permission Denied / RLS Policy (42501)
  if (
    lowerMessage.includes("permission denied") ||
    lowerMessage.includes("row-level security") ||
    (err instanceof DatabaseError && err.code === "42501")
  ) {
    return {
      category: "permission_denied",
      title: "Access Denied",
      copy: "You do not have the required permissions to perform this action. Row-level security policies prevent saving these changes.",
      safeToRetry: false,
      originalError: err,
    };
  }

  // 4. Ambiguous Money-Path Outcome
  // Thrown during submission to Stellar network, but without a clear rejection or success (network timeout, 504 Gateway Timeout, fetch failed)
  const isStellarSubmission =
    lowerMessage.includes("submittransaction") ||
    lowerMessage.includes("horizon") ||
    lowerMessage.includes("stellar") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("504") ||
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("networkerror");

  const hasResultCodes =
    err &&
    typeof err === "object" &&
    ("response" in err || "extras" in err || message.includes("Transaction failed:") || message.includes("Operation failed:"));

  if (isStellarSubmission && !hasResultCodes) {
    return {
      category: "ambiguous_submission",
      title: "Payment Status Ambiguous",
      copy: "The transaction was submitted to the Stellar network, but we did not receive a response. The payment may have succeeded. Please check your wallet's transaction history or reload the page before retrying to avoid duplicate payments.",
      safeToRetry: false,
      originalError: err,
    };
  }

  // 5. Stellar Operation Failure (rejected by network with specific result code)
  if (
    hasResultCodes ||
    /insufficient.*balance/i.test(lowerMessage) ||
    lowerMessage.includes("underfunded") ||
    lowerMessage.includes("recipient") ||
    lowerMessage.includes("trustline")
  ) {
    return {
      category: "stellar_operation",
      title: "Transaction Rejected",
      copy: message || "The transaction was rejected by the Stellar network.",
      safeToRetry: true,
      originalError: err,
    };
  }

  // 6. Network / Connection issue
  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("connection") ||
    lowerMessage.includes("offline") ||
    lowerMessage.includes("failed to fetch")
  ) {
    return {
      category: "network_temporary",
      title: "Connection Lost",
      copy: "A network error occurred. Please check your internet connection and try again.",
      safeToRetry: true,
      originalError: err,
    };
  }

  // 7. Generic / Unknown Error
  return {
    category: "generic",
    title: "Something Went Wrong",
    copy: message || "An unexpected error occurred.",
    safeToRetry: true,
    originalError: err,
  };
}
