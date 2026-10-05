import type { Metadata } from "next";
import { generateTripMetadata } from "./page";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }> | { id: string };
  searchParams?: Promise<{ name?: string; wallet?: string }> | { name?: string; wallet?: string };
}): Promise<Metadata> {
  const resolvedParams = await Promise.resolve(params);
  const resolvedSearch = searchParams ? await Promise.resolve(searchParams) : {};

  return generateTripMetadata({
    tripId: resolvedParams?.id,
    tripName: resolvedSearch?.name,
    walletAddress: resolvedSearch?.wallet,
  });
}

export default function TripLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
