/**
 * Turns due occurrences into drafts. Shared by the scheduled job (service
 * role, every active template) and the trip page (the member's own RLS, that
 * trip's templates), so a deployment without a scheduler still gets drafts the
 * next time someone opens the trip.
 *
 * A draft is inert data. Nothing here — or anything this module imports —
 * builds a transaction, asks for a wallet signature or writes an expense; the
 * architecture test in __tests__/recurring/noAutoSigning.test.ts keeps it that way.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import type { OccurrenceException, RecurringTemplate } from "@/types/recurring";
import { buildDraftPayload, dueOccurrences } from "./schedule";
import { insertDraftsIdempotent } from "./queries";

export interface GenerationResult {
  created: number;
  /** Templates whose drafts could not be written (the rest still were). */
  failedTemplateIds: string[];
}

export function planDrafts(
  templates: RecurringTemplate[],
  exceptions: OccurrenceException[],
  today: string,
) {
  return templates.flatMap((template) => {
    const byDate = new Map(
      exceptions.filter((e) => e.templateId === template.id).map((e) => [e.occurrenceDate, e]),
    );
    return dueOccurrences(template, exceptions, today).map((occurrenceDate) => ({
      templateId: template.id,
      templateVersion: template.version,
      occurrenceDate,
      payload: buildDraftPayload(template, byDate.get(occurrenceDate) ?? null),
    }));
  });
}

export async function generateDueDrafts(
  client: SupabaseClient<Database>,
  templates: RecurringTemplate[],
  exceptions: OccurrenceException[],
  today: string,
): Promise<GenerationResult> {
  const result: GenerationResult = { created: 0, failedTemplateIds: [] };
  for (const template of templates) {
    const planned = planDrafts([template], exceptions, today);
    if (planned.length === 0) continue;
    try {
      result.created += (await insertDraftsIdempotent(planned, client)).length;
    } catch {
      // One bad template must not stop every other group's drafts.
      result.failedTemplateIds.push(template.id);
    }
  }
  return result;
}
