/**
 * lib/idempotency/replay.ts
 *
 * What an idempotency record may keep of a response (Issue #414).
 *
 * The raw response is never stored. A route declares the fields a retry
 * needs (`replayFields`); only those are kept, as the "replay summary". The
 * summary is capped at IDEMPOTENCY_MAX_REPLAY_BYTES, and a SHA-256 digest of
 * the full original body is kept so an operator can still match a request to
 * what was sent, after the summary itself is gone.
 *
 * Field paths:
 *   "id"                 a top-level field (its whole value)
 *   "data.id"            a nested field
 *   "members[].name"     a field of every element of an array
 *   "attestation"        a whole subtree, when every part of it is needed
 *
 * Anything not named is dropped, so a field added to a response later is not
 * stored until someone adds it to the allowlist on purpose.
 */

import crypto from "crypto";
import { IDEMPOTENCY_MAX_REPLAY_BYTES } from "./retention";

type FieldTree = { [segment: string]: FieldTree | true };

const ARRAY = "[]";

function compile(paths: readonly string[]): FieldTree {
  const root: FieldTree = {};
  for (const path of paths) {
    const segments: string[] = [];
    for (const part of path.split(".")) {
      if (!part) throw new Error(`Invalid replay field path: "${path}"`);
      const name = part.replace(/(\[\])+$/, "");
      const arrays = (part.length - name.length) / 2;
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Invalid replay field path: "${path}"`);
      segments.push(name, ...Array<string>(arrays).fill(ARRAY));
    }
    let node = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const existing = node[segment];
      if (existing === true) break; // an ancestor already keeps the whole value
      if (index === segments.length - 1) {
        node[segment] = true;
        break;
      }
      if (!existing) node[segment] = {};
      node = node[segment] as FieldTree;
    }
  }
  return root;
}

function pick(value: unknown, tree: FieldTree | true): unknown {
  if (tree === true) return value;
  if (Array.isArray(value)) {
    const element = tree[ARRAY];
    return element ? value.map((item) => pick(item, element)) : undefined;
  }
  if (value !== null && typeof value === "object") {
    // The allowlist expected an array here; a plain object is a mismatch.
    if (tree[ARRAY] && Object.keys(tree).length === 1) return undefined;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(tree)) {
      if (key === ARRAY || !Object.prototype.hasOwnProperty.call(source, key)) continue;
      const picked = pick(source[key], child);
      if (picked !== undefined) out[key] = picked;
    }
    return out;
  }
  // A primitive where the allowlist expected structure is not what was declared.
  return undefined;
}

const compiled = new Map<string, FieldTree>();

/** Keeps only the allowlisted fields of a parsed JSON body. */
export function summarizeForReplay(body: unknown, replayFields: readonly string[]): unknown {
  const cacheKey = replayFields.join("\n");
  let tree = compiled.get(cacheKey);
  if (!tree) {
    tree = compile(replayFields);
    compiled.set(cacheKey, tree);
  }
  if (body === null || body === undefined) return null;
  if (typeof body !== "object") return null;
  const picked = pick(body, tree);
  return picked === undefined ? null : picked;
}

/** `sha256` hex digest of a response body as sent. */
export function digestResponseBody(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export interface StoredReplay {
  /** The allowlisted summary, or null when omitted. */
  body: unknown;
  /** SHA-256 hex of the full original body. */
  digest: string;
  /** Size of the full original body in bytes. */
  bytes: number;
  /** True when the summary exceeded the cap and was not stored. */
  omitted: boolean;
}

/**
 * Builds what is persisted for a completed response: the summary when it fits
 * the cap, otherwise nothing but the digest and size.
 */
export function buildStoredReplay(
  originalText: string,
  parsedBody: unknown,
  replayFields: readonly string[],
): StoredReplay {
  const summary = summarizeForReplay(parsedBody, replayFields);
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary ?? null), "utf8");
  const omitted = summaryBytes > IDEMPOTENCY_MAX_REPLAY_BYTES;
  return {
    body: omitted ? null : summary,
    digest: digestResponseBody(originalText),
    bytes: Buffer.byteLength(originalText, "utf8"),
    omitted,
  };
}

/** The body a retry receives when the summary was too large to keep. */
export function omittedReplayBody(digest: string | null | undefined) {
  return {
    idempotentReplay: {
      completed: true,
      bodyOmitted: true,
      reason: "The original response exceeded the stored replay size limit.",
      digest: digest ?? null,
    },
  };
}

// ─── Allowlists for the shapes the public mutations return ───────────────────

function under(prefix: string, fields: readonly string[]): string[] {
  return fields.map((field) => `${prefix}.${field}`);
}

const MEMBER_FIELDS = ["id", "name", "walletAddress", "weight", "role", "customPermissions"] as const;

const SHARE_FIELDS = [
  "memberId",
  "name",
  "walletAddress",
  "amount",
  "paid",
  "txHash",
  "paidStroops",
  "installments[].seq",
  "installments[].amount",
  "installments[].amountStroops",
  "installments[].txHash",
  "installments[].ledger",
  "installments[].verified",
] as const;

/**
 * An expense as a client needs it to render. Free-text fields (description,
 * void and correction reasons) are left out; the client re-reads them.
 */
export const EXPENSE_REPLAY_FIELDS: readonly string[] = [
  "id",
  "title",
  "totalAmount",
  "currency",
  "exchangeRate",
  "exchangeRateTimestamp",
  "exchangeRateSource",
  "enteredAmount",
  "settlementAsset",
  "category",
  "tags",
  "splitMode",
  "paidByMemberId",
  "createdAt",
  "updatedAt",
  "settled",
  "version",
  "voided",
  "voidedAt",
  "voidedByWallet",
  "correctionOfExpenseId",
  "correctionType",
  ...under("members[]", MEMBER_FIELDS),
  ...under("shares[]", SHARE_FIELDS),
];

/** A trip as a client needs it to render; description and workspace data are left out. */
export const TRIP_REPLAY_FIELDS: readonly string[] = [
  "id",
  "name",
  "expenseIds",
  "createdAt",
  "settled",
  "createdByWallet",
  "startsOn",
  "endsOn",
  "sourceTemplateId",
  "copiedFromTripId",
  "householdCoordinationEnabled",
  ...under("members[]", MEMBER_FIELDS),
];

/** Receipt metadata; caption, checksum and storage details are left out. */
export const RECEIPT_REPLAY_FIELDS: readonly string[] = [
  "id",
  "expenseId",
  "fileName",
  "contentType",
  "sizeBytes",
  "status",
  "uploadedByWallet",
  "createdAt",
  "retainUntil",
  "removedAt",
];

/** A reminder's state; the note and both wallets are left out. */
export const REMINDER_REPLAY_FIELDS: readonly string[] = [
  "id",
  "tripId",
  "expenseId",
  "memberId",
  "amount",
  "asset",
  "trigger",
  "scheduleId",
  "state",
  "channels",
  "createdAt",
  "readAt",
];

/** Mute choices only; e-mail address and push endpoint are left out. */
export const REMINDER_PREFERENCE_REPLAY_FIELDS: readonly string[] = [
  "emailOptIn",
  "pushOptIn",
  "mutedTripIds",
  "mutedSenderWallets",
];

export const REMINDER_SCHEDULE_REPLAY_FIELDS: readonly string[] = [
  "id",
  "tripId",
  "intervalDays",
  "nextRunAt",
  "active",
];

/** A support proposal's lifecycle; reason, details and execution output are left out. */
export const SUPPORT_PROPOSAL_REPLAY_FIELDS: readonly string[] = [
  "id",
  "actionType",
  "targetId",
  "targetType",
  "ticketRef",
  "proposedBy",
  "proposedAt",
  "approvedBy",
  "approvedAt",
  "status",
  "expiresAt",
];

export { under as replayFieldsUnder };
