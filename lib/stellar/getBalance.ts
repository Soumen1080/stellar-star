import { HORIZON_URL } from "@/lib/utils/constants";

export async function getXLMBalance(publicKey: string, signal?: AbortSignal): Promise<string> {
  const url = `${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`;

  const res = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    signal, // Pass the abort signal to the underlying fetch
  });

  // An unfunded account is a 404 on Horizon, because it does not exist yet.
  // That is a state with a next step — see `lib/stellar/accountState.ts` and the
  // onboarding flow — not a failure, so it reports a zero balance rather than
  // throwing. Throwing here is what made a new user's first screen a dead end.
  if (res.status === 404) {
    return "0";
  }

  if (!res.ok) {
    throw new Error(`Horizon ${res.status}: failed to fetch balance for ${publicKey}`);
  }

  const data = await res.json() as {
    balances?: Array<{ asset_type: string; balance: string }>;
  };

  const native = data.balances?.find((b) => b.asset_type === "native");
  return native?.balance ?? "0";
}
