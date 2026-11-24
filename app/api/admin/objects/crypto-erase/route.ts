/**
 * app/api/admin/objects/crypto-erase/route.ts
 *
 * Issue #453: Cryptographic erasure of private objects or master keys.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization } from "@/lib/support/service";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { cryptoEraseObject, cryptoEraseKey } from "@/lib/security/objectEncryption";
import { appendPrivilegedAudit } from "@/lib/audit/privilegedAudit";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  const staffAuth = checkStaffAuthorization(request);
  let actorWallet = "staff:operator";
  if (!staffAuth.authorized) {
    const userAuth = await authenticateWalletRequest(request);
    if (!userAuth.ok) {
      return NextResponse.json(
        { error: "Unauthorized: Access restricted to authorized operators or wallet sessions.", code: "AUTH_REQUIRED" },
        { status: 403, headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }
    actorWallet = userAuth.wallet;
  } else {
    actorWallet = `staff:${staffAuth.staffIdentifier}`;
  }

  const parsed = await parseJsonBody<{
    bucket?: string;
    storagePath?: string;
    keyId?: string;
  }>(request);

  if (!parsed.ok) return parsed.response;

  const { bucket, storagePath, keyId } = parsed.value;

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database not configured.", code: "SERVICE_UNAVAILABLE" },
      { status: 503, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  const serviceClient = createServiceRoleClient();

  try {
    if (keyId) {
      // Erase master key material
      await cryptoEraseKey(serviceClient, { keyId, actorWallet, requestId });
      await appendPrivilegedAudit(
        {
          actorWallet,
          actorRole: staffAuth.authorized ? "support" : "admin",
          action: "object.crypto_erase_key",
          decision: "execute",
          targetType: "key",
          targetId: keyId,
          requestId,
          metadata: { keyId },
        },
        serviceClient
      );
      return NextResponse.json(
        { data: { erasedKeyId: keyId, status: "erased" }, requestId },
        { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }

    if (bucket && storagePath) {
      // Erase individual object
      await cryptoEraseObject(serviceClient, { bucket, storagePath, actorWallet, requestId });
      await appendPrivilegedAudit(
        {
          actorWallet,
          actorRole: staffAuth.authorized ? "support" : "admin",
          action: "object.crypto_erase_object",
          decision: "execute",
          targetType: "storage_object",
          targetId: `${bucket}/${storagePath}`,
          requestId,
          metadata: { bucket, storagePath },
        },
        serviceClient
      );
      return NextResponse.json(
        { data: { storagePath, status: "erased" }, requestId },
        { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }

    return NextResponse.json(
      { error: "Provide either keyId or both bucket and storagePath.", code: "INVALID_ARGUMENTS" },
      { status: 400, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to execute crypto-erasure.", code: "ERASURE_FAILED", requestId },
      { status: 500, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }
}
