/**
 * Trip templates and duplicate-from-history (#321).
 *
 * ## The one rule this module enforces
 *
 * A copy carries the group's *structure* forward — who is in it, what they
 * usually spend on together, what members may do — and never its *history*.
 * Expense ids, shares, paid flags, transaction hashes, the settled flag and
 * every balance derived from them stay with the source. The functions below
 * build the copy from an explicit allow-list of fields rather than spreading
 * the source and deleting what should not travel, so a field added to `Trip`
 * later is excluded by default instead of leaking by default.
 *
 * Member ids are regenerated on every copy. Expense shares reference members by
 * id, so reusing them would let a stale share from the source trip appear to
 * belong to a member of the new one. Recurring rules are remapped through the
 * same table so a rule's payer still points at the right person.
 *
 * Everything here is pure: id generation and "today" are injectable so the
 * behaviour is deterministic under test.
 */

import { Money } from "@/lib/money";
import { normalizeWalletAddress } from "@/lib/trip/members";
import type { Member, SplitMode } from "@/types/expense";
import type {
  RecurringCadence,
  RecurringExpenseRule,
  Trip,
  TripCopySource,
  TripFormData,
  TripPermissions,
  TripTemplate,
} from "@/types/trip";

export type IdFactory = () => string;

const defaultId: IdFactory = () => crypto.randomUUID();

export const DEFAULT_TRIP_PERMISSIONS: Readonly<TripPermissions> = Object.freeze({
  membersCanAddExpenses: true,
  membersCanInvite: true,
});

export const RECURRING_CADENCES: readonly RecurringCadence[] = ["per_trip", "weekly", "monthly"];

export const CADENCE_LABELS: Record<RecurringCadence, string> = {
  per_trip: "Once per trip",
  weekly: "Weekly",
  monthly: "Monthly",
};

const SPLIT_MODES: readonly SplitMode[] = ["equal", "custom"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Normalisers ──────────────────────────────────────────────────────────────

/** Fills missing flags with the defaults; never trusts a non-boolean. */
export function normalizePermissions(value: unknown): TripPermissions {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<
    Record<keyof TripPermissions, unknown>
  >;
  return {
    membersCanAddExpenses:
      typeof raw.membersCanAddExpenses === "boolean"
        ? raw.membersCanAddExpenses
        : DEFAULT_TRIP_PERMISSIONS.membersCanAddExpenses,
    membersCanInvite:
      typeof raw.membersCanInvite === "boolean"
        ? raw.membersCanInvite
        : DEFAULT_TRIP_PERMISSIONS.membersCanInvite,
  };
}

/** A positive amount in canonical 7-decimal form, or null. */
export function normalizeRuleAmount(amount: unknown): string | null {
  const parsed = Money.tryParse(typeof amount === "string" ? amount.trim() : amount);
  if (!parsed || !parsed.isPositive()) return null;
  return parsed.toString();
}

/**
 * Drops rules that cannot be turned into an expense (no title, unparsable
 * amount, unknown cadence) and canonicalises the rest. Rows read back from
 * JSONB pass through here, so a hand-edited column cannot inject garbage.
 */
export function normalizeRecurringRules(value: unknown): RecurringExpenseRule[] {
  if (!Array.isArray(value)) return [];
  const rules: RecurringExpenseRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const amount = normalizeRuleAmount(raw.amount);
    if (!title || !amount) continue;
    const cadence = RECURRING_CADENCES.includes(raw.cadence as RecurringCadence)
      ? (raw.cadence as RecurringCadence)
      : "per_trip";
    const splitMode = SPLIT_MODES.includes(raw.splitMode as SplitMode)
      ? (raw.splitMode as SplitMode)
      : "equal";
    rules.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : defaultId(),
      title,
      amount,
      splitMode,
      paidByMemberId:
        typeof raw.paidByMemberId === "string" && raw.paidByMemberId
          ? raw.paidByMemberId
          : undefined,
      cadence,
    });
  }
  return rules;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** Inclusive length of a trip in days, or undefined when dates are unusable. */
export function tripDurationDays(startsOn?: string, endsOn?: string): number | undefined {
  if (!isIsoDate(startsOn) || !isIsoDate(endsOn)) return undefined;
  const days = Math.round(
    (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / MS_PER_DAY,
  );
  return days >= 0 ? days + 1 : undefined;
}

/** `startsOn` + (`durationDays` - 1), as an ISO date. */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ─── Member copying ───────────────────────────────────────────────────────────

/**
 * Copies a member list with fresh ids and returns the old→new id table.
 *
 * Only identity fields travel. `weight` is a per-expense split input, so it is
 * reset; wallet addresses are canonicalised on the way through.
 */
export function copyMembers(
  members: Member[],
  newId: IdFactory = defaultId,
): { members: Member[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const copied = members
    .filter((member) => member && typeof member.name === "string" && member.name.trim())
    .map((member) => {
      const id = newId();
      idMap.set(member.id, id);
      const wallet = normalizeWalletAddress(member.walletAddress);
      return {
        id,
        name: member.name.trim(),
        ...(wallet ? { walletAddress: wallet } : {}),
      };
    });
  return { members: copied, idMap };
}

/** Copies rules with fresh ids, pointing payers at the remapped members. */
export function copyRecurringRules(
  rules: RecurringExpenseRule[] | undefined,
  idMap: Map<string, string>,
  newId: IdFactory = defaultId,
): RecurringExpenseRule[] {
  return normalizeRecurringRules(rules ?? []).map((rule) => ({
    ...rule,
    id: newId(),
    paidByMemberId: rule.paidByMemberId ? idMap.get(rule.paidByMemberId) : undefined,
  }));
}

// ─── Building copies ──────────────────────────────────────────────────────────

export interface CopyOptions {
  newId?: IdFactory;
  /** "Today" for date suggestions, injectable for tests. */
  now?: Date;
}

/** Template fields derived from an existing trip. History never crosses. */
export type TemplateDraft = Omit<TripTemplate, "id" | "ownerWallet" | "createdAt" | "updatedAt">;

export function buildTemplateFromTrip(trip: Trip, options: CopyOptions = {}): TemplateDraft {
  const newId = options.newId ?? defaultId;
  const { members, idMap } = copyMembers(trip.members, newId);
  return {
    name: trip.name.trim(),
    description: trip.description?.trim() || undefined,
    members,
    recurringRules: copyRecurringRules(trip.recurringRules, idMap, newId),
    permissions: normalizePermissions(trip.permissions),
    durationDays: tripDurationDays(trip.startsOn, trip.endsOn),
    sourceTripId: trip.id,
  };
}

function suggestedDates(durationDays: number | undefined, now: Date) {
  if (!durationDays) return { startsOn: undefined, endsOn: undefined };
  const startsOn = todayIso(now);
  return { startsOn, endsOn: addDays(startsOn, durationDays - 1) };
}

/**
 * Editable form data for a new trip started from a template. The user can
 * change every field before anything is written.
 */
export function buildTripDraftFromTemplate(
  template: TripTemplate,
  options: CopyOptions = {},
): TripFormData {
  const newId = options.newId ?? defaultId;
  const { members, idMap } = copyMembers(template.members, newId);
  return {
    name: template.name,
    description: template.description ?? "",
    members,
    recurringRules: copyRecurringRules(template.recurringRules, idMap, newId),
    permissions: normalizePermissions(template.permissions),
    ...suggestedDates(template.durationDays, options.now ?? new Date()),
  };
}

/** Editable form data for a new trip duplicated from a past one. */
export function buildTripDraftFromTrip(trip: Trip, options: CopyOptions = {}): TripFormData {
  const newId = options.newId ?? defaultId;
  const { members, idMap } = copyMembers(trip.members, newId);
  return {
    name: `${trip.name.trim()} (copy)`,
    description: trip.description ?? "",
    members,
    recurringRules: copyRecurringRules(trip.recurringRules, idMap, newId),
    permissions: normalizePermissions(trip.permissions),
    ...suggestedDates(tripDurationDays(trip.startsOn, trip.endsOn), options.now ?? new Date()),
  };
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export interface CopyPreview {
  /** Human-readable lines for what the new trip will start with. */
  copied: string[];
  /** Human-readable lines for what is deliberately left behind. */
  excluded: string[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What a copy will and will not bring across, so the user sees it before
 * confirming. Built from the same inputs the copy itself uses.
 */
export function describeCopy(
  source: { kind: "template"; template: TripTemplate } | { kind: "trip"; trip: Trip },
): CopyPreview {
  const structure =
    source.kind === "template"
      ? {
          members: source.template.members,
          rules: source.template.recurringRules,
          permissions: source.template.permissions,
          durationDays: source.template.durationDays,
        }
      : {
          members: source.trip.members,
          rules: source.trip.recurringRules ?? [],
          permissions: source.trip.permissions,
          durationDays: tripDurationDays(source.trip.startsOn, source.trip.endsOn),
        };

  const members = structure.members.filter((m) => m?.name?.trim());
  const withWallet = members.filter((m) => normalizeWalletAddress(m.walletAddress)).length;
  const rules = normalizeRecurringRules(structure.rules);
  const permissions = normalizePermissions(structure.permissions);

  const copied = [
    `${plural(members.length, "member")} (${withWallet} with a wallet address)`,
    rules.length > 0 ? plural(rules.length, "recurring expense rule") : "No recurring expense rules",
    `Permissions: members ${permissions.membersCanAddExpenses ? "can" : "cannot"} add expenses, ${
      permissions.membersCanInvite ? "can" : "cannot"
    } invite`,
  ];
  if (structure.durationDays) {
    copied.push(`Trip length of ${plural(structure.durationDays, "day")} (dates are suggested, not copied)`);
  }

  const excluded = ["Balances and who-owes-whom", "Payment history and transaction hashes"];
  if (source.kind === "trip") {
    excluded.unshift(plural(source.trip.expenseIds.length, "past expense"));
    excluded.push("Settled status");
  }

  return { copied, excluded };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates the editable draft before it is sent. Mirrors the checks the
 * database function repeats, so the user sees the problem in the form rather
 * than as a rejected write.
 */
export function validateTripDraft(draft: TripFormData): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = "Trip name is required";
  if (draft.members.filter((m) => m.name.trim()).length < 2) {
    errors.members = "Add at least 2 members";
  }

  const { startsOn, endsOn } = draft;
  if (startsOn && !isIsoDate(startsOn)) errors.startsOn = "Enter a valid start date";
  if (endsOn && !isIsoDate(endsOn)) errors.endsOn = "Enter a valid end date";
  if (isIsoDate(startsOn) && isIsoDate(endsOn) && endsOn < startsOn) {
    errors.endsOn = "End date must be on or after the start date";
  }

  const memberIds = new Set(draft.members.map((m) => m.id));
  (draft.recurringRules ?? []).forEach((rule, i) => {
    if (!rule.title.trim()) errors[`rule_title_${i}`] = "Give this rule a title";
    if (!normalizeRuleAmount(rule.amount)) {
      errors[`rule_amount_${i}`] = "Enter a positive amount (up to 7 decimals)";
    }
    if (rule.paidByMemberId && !memberIds.has(rule.paidByMemberId)) {
      errors[`rule_payer_${i}`] = "Payer is no longer a member";
    }
  });

  return errors;
}

/**
 * The payload the copy RPC receives. Built only from the allow-listed draft
 * fields; `expense_ids` and `settled` are not even representable here, and the
 * database function sets them to empty/false regardless.
 */
export interface TripCopyPayload {
  id: string;
  name: string;
  description: string | null;
  members: Member[];
  starts_on: string | null;
  ends_on: string | null;
  recurring_rules: RecurringExpenseRule[];
  permissions: TripPermissions;
}

export function toTripCopyPayload(tripId: string, draft: TripFormData): TripCopyPayload {
  return {
    id: tripId,
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    members: draft.members
      .filter((m) => m.name.trim())
      .map((m) => {
        const wallet = normalizeWalletAddress(m.walletAddress);
        return { id: m.id, name: m.name.trim(), ...(wallet ? { walletAddress: wallet } : {}) };
      }),
    starts_on: draft.startsOn || null,
    ends_on: draft.endsOn || null,
    recurring_rules: normalizeRecurringRules(draft.recurringRules ?? []),
    permissions: normalizePermissions(draft.permissions),
  };
}

export interface TripCopyRequest {
  /**
   * Generated once when the user opens the copy flow and reused on every
   * retry, so a double-click or a retry after a dropped response returns the
   * trip that was already created instead of creating a second one.
   */
  idempotencyKey: string;
  source: TripCopySource;
  tripId: string;
  draft: TripFormData;
}

/** A fresh idempotency key for one copy attempt. */
export function newCopyIdempotencyKey(): string {
  return `copy_${crypto.randomUUID()}`;
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/** Whether `wallet` may perform `action` in `trip`. The creator always may. */
export function canPerformTripAction(
  trip: Pick<Trip, "createdByWallet" | "permissions">,
  wallet: string | null | undefined,
  action: keyof TripPermissions,
): boolean {
  const caller = normalizeWalletAddress(wallet);
  if (caller && caller === normalizeWalletAddress(trip.createdByWallet)) return true;
  return normalizePermissions(trip.permissions)[action];
}
