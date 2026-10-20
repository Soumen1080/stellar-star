import { NextResponse, type NextRequest } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import {
  createServerClientForToken,
  createServiceRoleClient,
  isServerSupabaseConfigured,
} from "@/lib/supabase/server";
import { ReceiptValidationError } from "./inspect";
import { ReceiptStoreError } from "./store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Receipt responses describe private documents; nothing may cache them. */
export function receiptJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" },
  });
}

export function receiptError(message: string, status: number) {
  return receiptJson({ error: message }, status);
}

export function errorResponse(err: unknown) {
  if (err instanceof ReceiptValidationError || err instanceof ReceiptStoreError) {
    return receiptError(err.message, err.status);
  }
  return receiptError("Something went wrong with this receipt. Please try again.", 500);
}

type Clients = {
  wallet: string;
  userClient: ReturnType<typeof createServerClientForToken>;
  serviceClient: NonNullable<ReturnType<typeof createServiceRoleClient>>;
};

/**
 * Authenticates the wallet session and builds both clients, or returns the
 * response to send instead.
 */
export function receiptClients(request: NextRequest): Clients | { response: NextResponse } {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;
  if (!session) {
    return { response: receiptError("Unauthorized: Sign in with your wallet to use receipts.", 401) };
  }
  if (!isServerSupabaseConfigured()) {
    return { response: receiptError("Database service is not configured on the server.", 503) };
  }
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    return {
      response: receiptError(
        "Receipt storage is not configured on this server (SUPABASE_SERVICE_ROLE_KEY is unset).",
        503,
      ),
    };
  }
  return {
    wallet: session.wallet_address,
    userClient: createServerClientForToken(token),
    serviceClient,
  };
}
