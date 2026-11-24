/**
 * app/api/admin/objects/rotate/route.ts
 *
 * Issue #453: Staging key rotation for private encrypted objects.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization } from "@/lib/support/service";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { rotateObjectKey, ObjectEncryptionError } from "@/lib/security/objectEncryption";
import { appendPrivilegedAudit } from "@/lib/audit/privilegedAudit";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  // Authorize caller (staff or authenticated wallet)
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
    targetKeyId?: string;
  }>(request);

  if (!parsed.ok) return parsed.response;

  const { bucket, storagePath, targetKeyId } = parsed.value;
  if (!bucket || !storagePath || !targetKeyId) {
    return NextResponse.json(
      { error: "Missing required fields: bucket, storagePath, targetKeyId.", code: "INVALID_ARGUMENTS" },
      { status: 400, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database not configured.", code: "SERVICE_UNAVAILABLE" },
      { status: 503, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  const serviceClient = createServiceRoleClient();

  try {
    const result = await rotateObjectKey(serviceClient, {
      bucket,
      storagePath,
      targetKeyId,
      actorWallet,
      requestId,
    });

    await appendPrivilegedAudit(
      {
        actorWallet,
        actorRole: staffAuth.authorized ? "support" : "admin",
        action: "object.rotate_key",
        decision: "execute",
        targetType: "storage_object",
        targetId: `${bucket}/${storagePath}`,
        requestId,
        metadata: { bucket, storagePath, targetKeyId },
      },
      serviceClient
    );

    return NextResponse.json(
      { data: result, requestId },
      { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof ObjectEncryptionError) {
      return NextResponse.json(
        { error: err.message, code: err.code, requestId },
        { status: err.status, headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }
    return NextResponse.json(
      { error: "Failed to rotate object encryption key.", code: "ROTATION_FAILED", requestId },
      { status: 500, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }
}
