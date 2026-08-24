/**
 * Every database read and write in the app goes through this module.
 *
 * Keeping the queries in one place means the column names, the row-to-domain
 * mapping and the error translation exist exactly once, instead of being
 * re-derived (and drifting) inside each React context.
 */

import type { PostgrestError } from "@supabase/supabase-js";
import type { Expense, Member, SplitShare } from "@/types/expense";
import type { Trip } from "@/types/trip";
import type {
  ExpenseInsert,
  ExpenseRow,
  ExpenseUpdate,
  TripInsert,
  TripRow,
  TripUpdate,
  UserRow,
} from "@/types/supabase";
import { requireAuthenticatedClient, requireSupabaseClient, type StellarStarClient } from "./client";

// ─── Domain shapes ────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  walletAddress: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

// ─── Error translation ────────────────────────────────────────────────────────

/**
 * Postgres/PostgREST error codes this app can act on.
 * PGRST116 - `.single()` matched no rows.
 * PGRST205 - table missing from the PostgREST schema cache.
 * 23505    - unique constraint violation.
 * 42501    - insufficient privilege (an RLS policy rejected the write).
 * PGRST301 - JWT missing, malformed or expired.
 */
export const PG_NO_ROWS = "PGRST116";
export const PG_SCHEMA_CACHE_MISS = "PGRST205";
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_INSUFFICIENT_PRIVILEGE = "42501";
export const PG_JWT_INVALID = "PGRST301";

export class DatabaseError extends Error {
  readonly code: string | undefined;
  readonly cause: unknown;

  constructor(message: string, code?: string, cause?: unknown) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
    this.cause = cause;
  }
}

function isMissingTable(error: PostgrestError): boolean {
  return (
    error.code === PG_SCHEMA_CACHE_MISS ||
    /schema cache/i.test(error.message) ||
    /relation .* does not exist/i.test(error.message)
  );
}

function isAuthProblem(error: PostgrestError): boolean {
  return (
    error.code === PG_JWT_INVALID ||
    error.code === PG_INSUFFICIENT_PRIVILEGE ||
    /\bJWT\b/i.test(error.message) ||
    /row-level security/i.test(error.message)
  );
}

/** Turns a PostgREST error into something worth putting in front of a user. */
export function toDatabaseError(error: PostgrestError, action: string): DatabaseError {
  if (isMissingTable(error)) {
    return new DatabaseError(
      `The database is not set up yet — the required tables are missing. Run supabase-setup.sql in the Supabase SQL Editor, then reload.`,
      error.code,
      error
    );
  }
  if (error.code === PG_UNIQUE_VIOLATION) {
    return new DatabaseError("That record already exists.", error.code, error);
  }
  if (isAuthProblem(error)) {
    return new DatabaseError(
      "Your wallet session is no longer valid. Please sign in with your wallet again.",
      error.code,
      error
    );
  }
  return new DatabaseError(error.message || `Failed to ${action}.`, error.code, error);
}

/** Unwraps a PostgREST result, throwing a translated error on failure. */
function unwrap<T>(
  result: { data: T | null; error: PostgrestError | null },
  action: string
): T {
  if (result.error) throw toDatabaseError(result.error, action);
  if (result.data === null) {
    throw new DatabaseError(`No data returned while trying to ${action}.`);
  }
  return result.data;
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

export function rowToUser(row: UserRow): UserProfile {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export function rowToExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    totalAmount: row.total_amount,
    currency: (row.currency as Expense["currency"]) ?? "XLM",
    splitMode: row.split_mode,
    paidByMemberId: row.paid_by_member_id,
    members: (row.members ?? []) as unknown as Member[],
    shares: (row.shares ?? []) as unknown as SplitShare[],
    createdAt: row.created_at,
    settled: row.settled,
  };
}

export function rowToTrip(row: TripRow): Trip {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    members: (row.members ?? []) as unknown as Member[],
    expenseIds: row.expense_ids ?? [],
    createdAt: row.created_at,
    settled: row.settled,
    createdByWallet: row.created_by_wallet,
  };
}

/**
 * Builds the insert payload for a new expense.
 *
 * `member_wallets` is deliberately absent: the `sync_member_wallets` trigger
 * derives it from `members` in the database. Deriving it client-side is how the
 * access array used to drift out of sync with the member list and quietly hide
 * rows from the people who were supposed to see them.
 */
export function expenseToInsert(expense: Expense, creatorWallet: string): ExpenseInsert {
  return {
    id: expense.id,
    title: expense.title,
    description: expense.description ?? null,
    total_amount: expense.totalAmount,
    currency: expense.currency ?? "XLM",
    split_mode: expense.splitMode,
    paid_by_member_id: expense.paidByMemberId,
    members: expense.members as unknown as ExpenseInsert["members"],
    shares: expense.shares as unknown as ExpenseInsert["shares"],
    settled: expense.settled,
    created_by_wallet: creatorWallet,
    created_at: expense.createdAt,
  };
}

/**
 * Maps a partial domain update to a partial column update.
 *
 * Only the fields the caller actually changed are sent. The previous code
 * rebuilt and wrote the whole row on every edit, which stamped the editing
 * wallet over `created_by_wallet` and silently transferred ownership of shared
 * expenses to whoever touched them last.
 */
export function expenseToUpdate(updates: Partial<Expense>): ExpenseUpdate {
  const patch: ExpenseUpdate = {};
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description ?? null;
  if (updates.totalAmount !== undefined) patch.total_amount = updates.totalAmount;
  if (updates.currency !== undefined) patch.currency = updates.currency;
  if (updates.splitMode !== undefined) patch.split_mode = updates.splitMode;
  if (updates.paidByMemberId !== undefined) patch.paid_by_member_id = updates.paidByMemberId;
  if (updates.members !== undefined) {
    patch.members = updates.members as unknown as ExpenseUpdate["members"];
  }
  if (updates.shares !== undefined) {
    patch.shares = updates.shares as unknown as ExpenseUpdate["shares"];
  }
  if (updates.settled !== undefined) patch.settled = updates.settled;
  return patch;
}

export function tripToInsert(trip: Trip, creatorWallet: string): TripInsert {
  return {
    id: trip.id,
    name: trip.name,
    description: trip.description ?? null,
    members: trip.members as unknown as TripInsert["members"],
    expense_ids: trip.expenseIds ?? [],
    settled: trip.settled,
    created_by_wallet: creatorWallet,
    created_at: trip.createdAt,
  };
}

export function tripToUpdate(updates: Partial<Trip>): TripUpdate {
  const patch: TripUpdate = {};
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.description !== undefined) patch.description = updates.description ?? null;
  if (updates.members !== undefined) {
    patch.members = updates.members as unknown as TripUpdate["members"];
  }
  if (updates.expenseIds !== undefined) patch.expense_ids = updates.expenseIds;
  if (updates.settled !== undefined) patch.settled = updates.settled;
  return patch;
}

// ─── Column lists ─────────────────────────────────────────────────────────────
// Explicit rather than `*`, so adding a column to the table cannot silently
// change what the app fetches or how much it transfers.

const USER_COLUMNS = "id, wallet_address, display_name, created_at, updated_at, last_login_at";
const EXPENSE_COLUMNS =
  "id, title, description, total_amount, currency, split_mode, paid_by_member_id, members, shares, settled, created_by_wallet, member_wallets, created_at, updated_at";
const TRIP_COLUMNS =
  "id, name, description, members, expense_ids, settled, created_by_wallet, member_wallets, created_at, updated_at";

// ─── Users ────────────────────────────────────────────────────────────────────

/** Fetches a profile by wallet address. Returns null when none exists. */
export async function fetchUserByWallet(
  walletAddress: string,
  client: StellarStarClient = requireSupabaseClient()
): Promise<UserProfile | null> {
  const { data, error } = await client
    .from("users")
    .select(USER_COLUMNS)
    .eq("wallet_address", walletAddress)
    .maybeSingle();

  // `maybeSingle` returns null rather than erroring when nothing matched, so a
  // brand-new wallet is an ordinary "no profile yet" instead of an exception.
  if (error) throw toDatabaseError(error, "load your profile");
  return data ? rowToUser(data as UserRow) : null;
}

/** Fetches the display names for a set of wallets, for member pickers. */
export async function fetchUsersByWallets(
  walletAddresses: string[],
  client: StellarStarClient = requireSupabaseClient()
): Promise<UserProfile[]> {
  const unique = [...new Set(walletAddresses.filter(Boolean))];
  if (unique.length === 0) return [];

  const { data, error } = await client
    .from("users")
    .select(USER_COLUMNS)
    .in("wallet_address", unique);

  if (error) throw toDatabaseError(error, "load member profiles");
  return (data ?? []).map((row) => rowToUser(row as UserRow));
}

/**
 * Creates the profile for the connected wallet, or refreshes an existing one.
 *
 * `onConflict: wallet_address` makes signing up twice — a double submit, a
 * retry after a flaky network — return the existing profile instead of a
 * unique-violation error. Requires a session whose `wallet_address` claim
 * equals `walletAddress`, which the RLS insert policy enforces.
 */
export async function upsertUserProfile(
  walletAddress: string,
  displayName: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<UserProfile> {
  const now = new Date().toISOString();
  const result = await client
    .from("users")
    .upsert(
      {
        wallet_address: walletAddress,
        display_name: displayName,
        last_login_at: now,
        updated_at: now,
      },
      { onConflict: "wallet_address" }
    )
    .select(USER_COLUMNS)
    .single();

  return rowToUser(unwrap(result, "create your profile") as UserRow);
}

/** Stamps a fresh login time and returns the profile. */
export async function touchUserLogin(
  walletAddress: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<UserProfile | null> {
  const { data, error } = await client
    .from("users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("wallet_address", walletAddress)
    .select(USER_COLUMNS)
    .maybeSingle();

  if (error) throw toDatabaseError(error, "sign in");
  return data ? rowToUser(data as UserRow) : null;
}

export async function updateUserDisplayName(
  walletAddress: string,
  displayName: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<UserProfile> {
  const result = await client
    .from("users")
    .update({ display_name: displayName })
    .eq("wallet_address", walletAddress)
    .select(USER_COLUMNS)
    .single();

  return rowToUser(unwrap(result, "update your profile") as UserRow);
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

/**
 * Every expense the session's wallet participates in.
 *
 * There is no `.eq()` on the wallet here on purpose: the RLS SELECT policy
 * already restricts rows to `member_wallets @> ARRAY[current_wallet()]`, and
 * duplicating that filter in the client would be a second place to get wrong.
 */
export async function fetchExpenses(
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Expense[]> {
  const { data, error } = await client
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw toDatabaseError(error, "load expenses");
  return (data ?? []).map((row) => rowToExpense(row as ExpenseRow));
}

export async function fetchExpenseById(
  id: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Expense | null> {
  const { data, error } = await client
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw toDatabaseError(error, "load that expense");
  return data ? rowToExpense(data as ExpenseRow) : null;
}

export async function insertExpense(
  expense: Expense,
  creatorWallet: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Expense> {
  const result = await client
    .from("expenses")
    .insert(expenseToInsert(expense, creatorWallet))
    .select(EXPENSE_COLUMNS)
    .single();

  return rowToExpense(unwrap(result, "save this expense") as ExpenseRow);
}

export async function updateExpenseRow(
  id: string,
  updates: Partial<Expense>,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Expense> {
  const patch = expenseToUpdate(updates);
  if (Object.keys(patch).length === 0) {
    const existing = await fetchExpenseById(id, client);
    if (!existing) throw new DatabaseError("That expense no longer exists.");
    return existing;
  }

  const result = await client
    .from("expenses")
    .update(patch)
    .eq("id", id)
    .select(EXPENSE_COLUMNS)
    .single();

  return rowToExpense(unwrap(result, "update this expense") as ExpenseRow);
}

export async function deleteExpenseRow(
  id: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<void> {
  const { error } = await client.from("expenses").delete().eq("id", id);
  if (error) throw toDatabaseError(error, "delete this expense");
}

/**
 * Marks one member's share as paid.
 *
 * Re-reads `shares` immediately before writing so a concurrent payment by
 * another member is not overwritten by a stale copy held in this browser.
 */
export async function markSharePaidRow(
  expenseId: string,
  memberId: string,
  txHash: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Expense> {
  const { data: fresh, error: fetchError } = await client
    .from("expenses")
    .select("shares")
    .eq("id", expenseId)
    .maybeSingle();

  if (fetchError) throw toDatabaseError(fetchError, "record this payment");
  if (!fresh) {
    throw new DatabaseError(
      "Payment sent on Stellar, but the expense could not be found. Make sure your wallet address is listed on this expense."
    );
  }

  const shares = ((fresh.shares ?? []) as unknown as SplitShare[]).map((share) =>
    share.memberId === memberId ? { ...share, paid: true, txHash } : share
  );
  const settled = shares.length > 0 && shares.every((share) => share.paid);

  const result = await client
    .from("expenses")
    .update({ shares: shares as unknown as ExpenseUpdate["shares"], settled })
    .eq("id", expenseId)
    .select(EXPENSE_COLUMNS)
    .single();

  if (result.error) {
    throw toDatabaseError(result.error, "record this payment");
  }
  if (!result.data) {
    throw new DatabaseError(
      "Payment sent on Stellar but could not be recorded. Make sure your Stellar wallet address is entered correctly in the expense member list."
    );
  }
  return rowToExpense(result.data as ExpenseRow);
}

// ─── Trips ────────────────────────────────────────────────────────────────────

export async function fetchTrips(
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Trip[]> {
  const { data, error } = await client
    .from("trips")
    .select(TRIP_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw toDatabaseError(error, "load trips");
  return (data ?? []).map((row) => rowToTrip(row as TripRow));
}

export async function insertTrip(
  trip: Trip,
  creatorWallet: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Trip> {
  const result = await client
    .from("trips")
    .insert(tripToInsert(trip, creatorWallet))
    .select(TRIP_COLUMNS)
    .single();

  return rowToTrip(unwrap(result, "save this trip") as TripRow);
}

export async function updateTripRow(
  id: string,
  updates: Partial<Trip>,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<Trip> {
  const patch = tripToUpdate(updates);
  if (Object.keys(patch).length === 0) {
    const { data, error } = await client
      .from("trips")
      .select(TRIP_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw toDatabaseError(error, "load that trip");
    if (!data) throw new DatabaseError("That trip no longer exists.");
    return rowToTrip(data as TripRow);
  }

  const result = await client
    .from("trips")
    .update(patch)
    .eq("id", id)
    .select(TRIP_COLUMNS)
    .single();

  return rowToTrip(unwrap(result, "update this trip") as TripRow);
}

export async function deleteTripRow(
  id: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<void> {
  const { error } = await client.from("trips").delete().eq("id", id);
  if (error) throw toDatabaseError(error, "delete this trip");
}

/**
 * Attaches an expense to a trip.
 *
 * Reads the current array first and skips the write when the id is already
 * present, so re-adding the same expense is a no-op rather than a duplicate.
 */
export async function addExpenseIdToTrip(
  tripId: string,
  expenseId: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<string[]> {
  const { data, error } = await client
    .from("trips")
    .select("expense_ids")
    .eq("id", tripId)
    .maybeSingle();

  if (error) throw toDatabaseError(error, "add this expense to the trip");
  if (!data) throw new DatabaseError("That trip no longer exists.");

  const currentIds = data.expense_ids ?? [];
  if (currentIds.includes(expenseId)) return currentIds;

  const expenseIds = [...currentIds, expenseId];
  const result = await client
    .from("trips")
    .update({ expense_ids: expenseIds })
    .eq("id", tripId)
    .select("expense_ids")
    .single();

  const updated = unwrap(result, "add this expense to the trip");
  return updated.expense_ids ?? expenseIds;
}

/**
 * Removes a deleted expense's id from every trip that references it.
 * Without this, trips keep pointing at expenses that no longer exist and their
 * totals silently disagree with the expense list.
 */
export async function detachExpenseFromTrips(
  expenseId: string,
  client: StellarStarClient = requireAuthenticatedClient()
): Promise<void> {
  const { data, error } = await client
    .from("trips")
    .select("id, expense_ids")
    .contains("expense_ids", [expenseId]);

  if (error) throw toDatabaseError(error, "detach this expense from its trips");

  await Promise.all(
    (data ?? []).map((trip) =>
      client
        .from("trips")
        .update({
          expense_ids: (trip.expense_ids ?? []).filter((id: string) => id !== expenseId),
        })
        .eq("id", trip.id)
    )
  );
}

// ─── Connectivity ─────────────────────────────────────────────────────────────

export interface ConnectionStatus {
  ok: boolean;
  /** Set when the tables have not been created yet. */
  needsSetup: boolean;
  message?: string;
}

/**
 * A cheap round-trip that distinguishes "the database is unreachable" from
 * "the database is reachable but empty" from "the schema was never installed".
 */
export async function checkConnection(): Promise<ConnectionStatus> {
  const client = requireSupabaseClient();
  const { error } = await client.from("users").select("id", { head: true, count: "exact" }).limit(1);

  if (!error) return { ok: true, needsSetup: false };
  if (isMissingTable(error)) {
    return {
      ok: false,
      needsSetup: true,
      message: "Database tables are missing. Run supabase-setup.sql in the Supabase SQL Editor.",
    };
  }
  return { ok: false, needsSetup: false, message: error.message };
}
