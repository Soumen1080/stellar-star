import type { Json, BudgetAlertRow, TripBudgetRow } from "@/types/supabase";
import type { BudgetAlert, BudgetScope, TripBudget } from "@/types/budget";
import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { DatabaseError, PG_UNIQUE_VIOLATION, toDatabaseError } from "@/lib/supabase/queries";
import { planAlertChanges } from "./compute";

const BUDGET_COLUMNS = "trip_id, currency, total_amount, category_caps, thresholds, version, created_by_wallet, created_at, updated_at";
const ALERT_COLUMNS = "id, trip_id, scope, threshold, spent_at_crossing, fired_at, cleared_at";

export function rowToBudget(row: TripBudgetRow): TripBudget {
  return {
    tripId: row.trip_id,
    currency: row.currency,
    totalAmount: row.total_amount,
    categoryCaps: (row.category_caps ?? {}) as TripBudget["categoryCaps"],
    thresholds: [...(row.thresholds ?? [])].sort((a, b) => a - b),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function rowToAlert(row: BudgetAlertRow): BudgetAlert {
  return {
    id: row.id,
    tripId: row.trip_id,
    scope: row.scope as BudgetScope,
    threshold: row.threshold,
    spentAtCrossing: row.spent_at_crossing,
    firedAt: row.fired_at,
  };
}

export async function fetchTripBudget(
  tripId: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<TripBudget | null> {
  const { data, error } = await client.from("trip_budgets").select(BUDGET_COLUMNS).eq("trip_id", tripId).maybeSingle();
  if (error) throw toDatabaseError(error, "load the budget");
  return data ? rowToBudget(data as TripBudgetRow) : null;
}

export type BudgetInput = Pick<TripBudget, "currency" | "totalAmount" | "categoryCaps" | "thresholds">;

/** Creates or (version-checked) updates the trip's budget. */
export async function saveTripBudget(
  tripId: string,
  input: BudgetInput,
  existing: TripBudget | null,
  wallet: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<TripBudget> {
  const columns = {
    currency: input.currency,
    total_amount: input.totalAmount,
    category_caps: input.categoryCaps as unknown as Json,
    thresholds: [...new Set(input.thresholds)].sort((a, b) => a - b),
  };
  const { data, error } = existing
    ? await client
        .from("trip_budgets")
        .update({ ...columns, version: existing.version + 1 })
        .eq("trip_id", tripId)
        .eq("version", existing.version)
        .select(BUDGET_COLUMNS)
        .maybeSingle()
    : await client
        .from("trip_budgets")
        .insert({ ...columns, trip_id: tripId, created_by_wallet: wallet })
        .select(BUDGET_COLUMNS)
        .maybeSingle();
  if (error) throw toDatabaseError(error, "save the budget");
  if (!data) throw new DatabaseError("Someone else changed this budget. Reload and try again.", "40001");
  return rowToBudget(data as TripBudgetRow);
}

export async function fetchActiveAlerts(
  tripId: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<BudgetAlert[]> {
  const { data, error } = await client
    .from("budget_alerts")
    .select(ALERT_COLUMNS)
    .eq("trip_id", tripId)
    .is("cleared_at", null)
    .order("fired_at", { ascending: false });
  if (error) throw toDatabaseError(error, "load budget alerts");
  return (data ?? []).map((row) => rowToAlert(row as BudgetAlertRow));
}

/**
 * Brings stored alerts in line with what is currently crossed. Returns only
 * the alerts this call fired. A concurrent evaluator firing the same crossing
 * first is a unique violation here, which is the "fire once" guarantee doing
 * its job — it is ignored, not reported.
 */
export async function syncBudgetAlerts(
  tripId: string,
  crossed: Array<{ scope: BudgetScope; threshold: number; spent: number }>,
  active: BudgetAlert[],
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<BudgetAlert[]> {
  const { fire, clear } = planAlertChanges(crossed, active);
  const fired: BudgetAlert[] = [];

  for (const crossing of fire) {
    const { data, error } = await client
      .from("budget_alerts")
      .insert({
        trip_id: tripId,
        scope: crossing.scope,
        threshold: crossing.threshold,
        spent_at_crossing: crossing.spent.toFixed(2),
      })
      .select(ALERT_COLUMNS)
      .maybeSingle();
    if (error && error.code !== PG_UNIQUE_VIOLATION) throw toDatabaseError(error, "record a budget alert");
    if (data) fired.push(rowToAlert(data as BudgetAlertRow));
  }

  if (clear.length > 0) {
    const { error } = await client
      .from("budget_alerts")
      .update({ cleared_at: new Date().toISOString() })
      .in("id", clear);
    if (error) throw toDatabaseError(error, "re-arm budget alerts");
  }
  return fired;
}

export async function fetchAlertMute(
  tripId: string,
  wallet: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from("budget_alert_mutes")
    .select("trip_id")
    .eq("trip_id", tripId)
    .eq("member_wallet", wallet)
    .maybeSingle();
  if (error) throw toDatabaseError(error, "load alert preferences");
  return !!data;
}

export async function setAlertMute(
  tripId: string,
  wallet: string,
  muted: boolean,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<void> {
  const { error } = muted
    ? await client.from("budget_alert_mutes").upsert({ trip_id: tripId, member_wallet: wallet }, { onConflict: "trip_id,member_wallet", ignoreDuplicates: true })
    : await client.from("budget_alert_mutes").delete().eq("trip_id", tripId).eq("member_wallet", wallet);
  if (error) throw toDatabaseError(error, "update alert preferences");
}
