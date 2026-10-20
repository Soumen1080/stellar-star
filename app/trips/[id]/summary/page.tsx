"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { TripPrintSummary } from "@/components/export/TripPrintSummary";
import { TripNotFound } from "@/components/trips/TripNotFound";
import { Spinner } from "@/components/ui/Spinner";
import { useExpense } from "@/hooks/useExpense";
import { useTrip } from "@/hooks/useTrip";
import { STELLAR_EXPLORER } from "@/lib/utils/constants";
import { sanitizeText } from "@/lib/utils";

/**
 * Print-friendly trip summary (#324). "Save as PDF" in the browser's print
 * dialog produces the PDF, so no PDF library ships in the bundle.
 */
export default function TripSummaryPage() {
  const params = useParams<{ id: string }>();
  const tripId = sanitizeText(params?.id ?? "");
  const { getTrip, isLoading } = useTrip();
  const { expenses } = useExpense();
  const [includeReceipts, setIncludeReceipts] = useState(true);
  const [generatedAt] = useState(() => new Date());

  const trip = getTrip(tripId);
  const tripExpenses = useMemo(
    () => (trip ? expenses.filter((e) => trip.expenseIds.includes(e.id)) : []),
    [trip, expenses],
  );

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size={32} className="text-[#2DD4BF]" />
      </div>
    );
  }
  if (!trip) return <TripNotFound />;

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6] py-6 print:bg-white print:py-0">
        <div className="mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 print:hidden">
          <Link href={`/trips/${encodeURIComponent(trip.id)}`} className="flex items-center gap-1.5 text-sm text-[#888] hover:text-[#0F0F14]">
            <ArrowLeft size={14} />
            Back to trip
          </Link>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-[#555]">
              <input
                type="checkbox"
                checked={includeReceipts}
                onChange={(e) => setIncludeReceipts(e.target.checked)}
              />
              Include receipt links
            </label>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0F0F14] px-4 py-2 text-sm font-bold text-[#2DD4BF]"
            >
              <Printer size={14} />
              Print / Save as PDF
            </button>
          </div>
        </div>
        <TripPrintSummary
          trip={trip}
          expenses={tripExpenses}
          explorerBase={STELLAR_EXPLORER}
          includeReceipts={includeReceipts}
          generatedAt={generatedAt}
        />
      </div>
    </AuthGuard>
  );
}
