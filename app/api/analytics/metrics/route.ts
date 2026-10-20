import { NextResponse } from "next/server";
import { computeAggregateMetrics } from "@/lib/analytics";

export async function GET() {
  // Returns aggregated metrics
  const defaultMetrics = computeAggregateMetrics([]);
  return NextResponse.json({
    metrics: defaultMetrics,
    timestamp: new Date().toISOString(),
  });
}
