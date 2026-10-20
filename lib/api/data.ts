import { isServerSupabaseConfigured, createServiceRoleClient } from "@/lib/supabase/server";
import type { Trip } from "@/types/trip";
import type { Expense } from "@/types/expense";

declare global {
  var stellarStarSandboxTrips: Trip[] | undefined;
  var stellarStarSandboxExpenses: Expense[] | undefined;
}

const sandboxTrips: Trip[] = globalThis.stellarStarSandboxTrips ?? [];
globalThis.stellarStarSandboxTrips = sandboxTrips;

const sandboxExpenses: Expense[] = globalThis.stellarStarSandboxExpenses ?? [];
globalThis.stellarStarSandboxExpenses = sandboxExpenses;

export async function fetchPermittedTrips(
  walletAddress: string,
  limit = 20,
  cursor?: string | null
): Promise<{ trips: Trip[]; hasMore: boolean; nextCursor: string | null }> {
  const normalized = walletAddress.trim().toUpperCase();

  if (isServerSupabaseConfigured()) {
    try {
      const client = createServiceRoleClient();
      if (client) {
        let query = client
          .from("trips")
          .select("*")
          .contains("member_wallets", [normalized])
          .order("created_at", { ascending: false })
          .limit(limit + 1);

        if (cursor) {
          query = query.lt("created_at", cursor);
        }

        const { data, error } = await query;
        if (!error && Array.isArray(data)) {
          const hasMore = data.length > limit;
          const sliced = data.slice(0, limit);
          const mapped: Trip[] = sliced.map((row: any) => ({
            id: row.id,
            name: row.name,
            description: row.description ?? "",
            members: Array.isArray(row.members) ? row.members : [],
            expenseIds: Array.isArray(row.expense_ids) ? row.expense_ids : [],
            startsOn: row.starts_on ?? undefined,
            endsOn: row.ends_on ?? undefined,
            createdAt: row.created_at,
            settled: Boolean(row.settled),
            createdByWallet: row.created_by_wallet,
          }));

          const nextCursor = hasMore && mapped.length > 0 ? mapped[mapped.length - 1].createdAt : null;
          return { trips: mapped, hasMore, nextCursor };
        }
      }
    } catch {}
  }

  // Fallback to sandbox in-memory store
  let filtered = sandboxTrips.filter(
    (t) =>
      t.createdByWallet?.toUpperCase() === normalized ||
      t.members.some((m) => m.walletAddress?.toUpperCase() === normalized)
  );

  if (cursor) {
    const cursorTime = new Date(cursor).getTime();
    filtered = filtered.filter((t) => new Date(t.createdAt).getTime() < cursorTime);
  }

  filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const hasMore = filtered.length > limit;
  const sliced = filtered.slice(0, limit);
  const nextCursor = hasMore && sliced.length > 0 ? sliced[sliced.length - 1].createdAt : null;

  return { trips: sliced, hasMore, nextCursor };
}

export async function fetchTripById(
  tripId: string,
  walletAddress: string
): Promise<Trip | null> {
  const normalized = walletAddress.trim().toUpperCase();

  if (isServerSupabaseConfigured()) {
    try {
      const client = createServiceRoleClient();
      if (client) {
        const { data, error } = await client
          .from("trips")
          .select("*")
          .eq("id", tripId)
          .single();

        if (!error && data) {
          const isMember =
            data.created_by_wallet?.toUpperCase() === normalized ||
            (Array.isArray(data.member_wallets) &&
              data.member_wallets.map((w: string) => w.toUpperCase()).includes(normalized));

          if (!isMember) return null;

          return {
            id: data.id,
            name: data.name,
            description: data.description ?? "",
            members: Array.isArray(data.members) ? data.members : [],
            expenseIds: Array.isArray(data.expense_ids) ? data.expense_ids : [],
            startsOn: data.starts_on ?? undefined,
            endsOn: data.ends_on ?? undefined,
            createdAt: data.created_at,
            settled: Boolean(data.settled),
            createdByWallet: data.created_by_wallet,
          };
        }
      }
    } catch {}
  }

  const found = sandboxTrips.find((t) => t.id === tripId);
  if (!found) return null;

  const isMember =
    found.createdByWallet?.toUpperCase() === normalized ||
    found.members.some((m) => m.walletAddress?.toUpperCase() === normalized);

  return isMember ? { ...found } : null;
}

export async function insertTrip(trip: Trip): Promise<Trip> {
  if (isServerSupabaseConfigured()) {
    try {
      const client = createServiceRoleClient();
      if (client) {
        const memberWallets = trip.members
          .map((m) => m.walletAddress?.trim().toUpperCase())
          .filter(Boolean) as string[];

        await client.from("trips").insert({
          id: trip.id,
          name: trip.name,
          description: trip.description || null,
          members: trip.members as any,
          expense_ids: trip.expenseIds as any,
          starts_on: trip.startsOn || null,
          ends_on: trip.endsOn || null,
          settled: trip.settled,
          created_by_wallet: trip.createdByWallet?.toUpperCase() || "",
          member_wallets: memberWallets,
        });
      }
    } catch {}
  }

  sandboxTrips.unshift(trip);
  return trip;
}

export async function fetchExpensesForTrip(
  tripId: string,
  walletAddress: string,
  limit = 20
): Promise<{ expenses: Expense[]; hasMore: boolean }> {
  // Authorization check first
  const trip = await fetchTripById(tripId, walletAddress);
  if (!trip) return { expenses: [], hasMore: false };

  if (isServerSupabaseConfigured()) {
    try {
      const client = createServiceRoleClient();
      if (client) {
        const { data, error } = await client
          .from("expenses")
          .select("*")
          .in("id", trip.expenseIds)
          .limit(limit);

        if (!error && Array.isArray(data)) {
          const mapped: Expense[] = data.map((row: any) => ({
            id: row.id,
            title: row.title,
            description: row.description,
            totalAmount: row.total_amount,
            currency: row.currency,
            settled: Boolean(row.settled),
            paidByMemberId: row.paid_by_member_id,
            splitMode: row.split_mode,
            members: row.members ?? [],
            shares: row.shares ?? [],
            createdAt: row.created_at,
          }));
          return { expenses: mapped, hasMore: false };
        }
      }
    } catch {}
  }

  const expenses = sandboxExpenses.filter((e) => trip.expenseIds.includes(e.id)).slice(0, limit);
  return { expenses, hasMore: false };
}

export async function insertExpense(expense: Expense, tripId: string): Promise<Expense> {
  const trip = sandboxTrips.find((t) => t.id === tripId);
  if (trip) {
    trip.expenseIds.push(expense.id);
  }
  sandboxExpenses.unshift(expense);
  return expense;
}

export function clearSandboxData(): void {
  sandboxTrips.length = 0;
  sandboxExpenses.length = 0;
}
