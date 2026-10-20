/**
 * Recurrence math for expense templates (issue #319). Pure and timezone-free:
 * every value is a calendar date string (YYYY-MM-DD) and all arithmetic is done
 * on UTC midnights, so "the 31st of every month" never drifts by an hour.
 *
 * This module only decides *which dates* are due. It never builds, signs or
 * submits anything — drafts are suggestions a person reviews and saves through
 * the normal expense form.
 */

import type {
  Cadence,
  DraftPayload,
  OccurrenceException,
  RecurringTemplate,
} from "@/types/recurring";

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** How far back the generator catches up after downtime. Older dates are not back-filled. */
export const MAX_CATCH_UP_DAYS = 62;
/** Upper bound on occurrences produced per template per run. */
export const MAX_OCCURRENCES_PER_RUN = 31;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Today's calendar date in UTC. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The k-th occurrence (k = 0 is the start date).
 *
 * Monthly/yearly cadences keep the start's day-of-month as an anchor and clamp
 * it to short months: a template starting Jan 31 falls on Feb 28 (or 29), then
 * back on Mar 31 — not Mar 28, which is what repeatedly adding a month does.
 */
export function nthOccurrence(startDate: string, cadence: Cadence, k: number): string {
  if (cadence.unit === "day") return addDays(startDate, k * cadence.interval);
  if (cadence.unit === "week") return addDays(startDate, k * cadence.interval * 7);

  const [y, m, d] = startDate.split("-").map(Number);
  const monthsToAdd = k * cadence.interval * (cadence.unit === "year" ? 12 : 1);
  const totalMonths = (m - 1) + monthsToAdd;
  const year = y + Math.floor(totalMonths / 12);
  const monthIndex = ((totalMonths % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(year, monthIndex));
  return fromUtc(Date.UTC(year, monthIndex, day));
}

/** A lower bound on k for the first occurrence on or after `date`, so long series skip ahead. */
function firstIndexNear(startDate: string, cadence: Cadence, date: string): number {
  const deltaDays = (toUtc(date) - toUtc(startDate)) / DAY_MS;
  if (deltaDays <= 0) return 0;
  const approxDaysPerStep =
    cadence.unit === "day" ? 1 : cadence.unit === "week" ? 7 : cadence.unit === "month" ? 31 : 366;
  // Using the longest possible step undershoots, never overshoots.
  return Math.max(0, Math.floor(deltaDays / (approxDaysPerStep * cadence.interval)) - 1);
}

/** Occurrence dates in [from, to], respecting the template's start and end dates. */
export function occurrencesBetween(
  template: Pick<RecurringTemplate, "startDate" | "endDate" | "cadence">,
  from: string,
  to: string,
  limit: number = MAX_OCCURRENCES_PER_RUN,
): string[] {
  const lower = from > template.startDate ? from : template.startDate;
  const upper = template.endDate && template.endDate < to ? template.endDate : to;
  if (lower > upper) return [];

  const dates: string[] = [];
  for (let k = firstIndexNear(template.startDate, template.cadence, lower); dates.length < limit; k += 1) {
    const date = nthOccurrence(template.startDate, template.cadence, k);
    if (date > upper) break;
    if (date >= lower) dates.push(date);
  }
  return dates;
}

/**
 * Dates a run should create drafts for.
 *
 * Window: from max(generateFrom, today - catch-up) through today + reminder
 * lead days (a reminder is the draft appearing early). Paused/ended templates
 * produce nothing. Skipped dates are excluded; already-generated dates are
 * excluded by the database's unique (template_id, occurrence_date) key, which
 * is what makes a run idempotent even when two run concurrently.
 */
export function dueOccurrences(
  template: RecurringTemplate,
  exceptions: OccurrenceException[],
  today: string,
): string[] {
  if (template.status !== "active") return [];
  const catchUpFloor = addDays(today, -MAX_CATCH_UP_DAYS);
  const from = template.generateFrom > catchUpFloor ? template.generateFrom : catchUpFloor;
  const to = addDays(today, template.reminderLeadDays ?? 0);
  const skipped = new Set(
    exceptions
      .filter((e) => e.templateId === template.id && e.action === "skip")
      .map((e) => e.occurrenceDate),
  );
  return occurrencesBetween(template, from, to).filter((date) => !skipped.has(date));
}

/** Upcoming dates for display (next N on or after `from`), marking skipped ones. */
export function upcomingOccurrences(
  template: RecurringTemplate,
  exceptions: OccurrenceException[],
  from: string,
  count = 5,
): Array<{ date: string; exception: OccurrenceException | null }> {
  const byDate = new Map(
    exceptions.filter((e) => e.templateId === template.id).map((e) => [e.occurrenceDate, e]),
  );
  const start = template.generateFrom > from ? template.generateFrom : from;
  // Look far enough ahead to fill `count` even for yearly cadences.
  return occurrencesBetween(template, start, addDays(start, 366 * 5 * template.cadence.interval), count).map(
    (date) => ({ date, exception: byDate.get(date) ?? null }),
  );
}

/**
 * The frozen snapshot a draft carries. Occurrence overrides apply on top of
 * the template; members, payer and split are always the template's.
 */
export function buildDraftPayload(
  template: RecurringTemplate,
  exception: OccurrenceException | null,
): DraftPayload {
  const overrides = exception?.action === "override" ? exception.overrides : {};
  const rule = template.amountRule;
  const baseAmount = rule.kind === "fixed" ? rule.amount : rule.estimate ?? "";
  return {
    title: overrides.title?.trim() || template.title,
    description: overrides.description !== undefined ? overrides.description : template.description,
    category: template.category,
    tags: [...template.tags],
    currency: template.currency,
    amount: overrides.amount ?? baseAmount,
    amountKind: rule.kind,
    splitMode: template.splitMode,
    paidByMemberId: template.paidByMemberId,
    members: template.members.map((member) => ({ ...member })),
  };
}

export function describeCadence(cadence: Cadence): string {
  const unit = cadence.unit;
  if (cadence.interval === 1) {
    return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit];
  }
  return `Every ${cadence.interval} ${unit}s`;
}
