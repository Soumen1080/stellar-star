import { HORIZON_URL } from "@/lib/utils/constants";
import { isNative, type AssetRef } from "@/lib/stellar/assets";

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

  const data = (await res.json()) as {
    balances?: Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }>;
  };

  const native = data.balances?.find((b) => b.asset_type === "native");
  return native?.balance ?? "0";
}

/** Fetches balance for any classic Stellar asset (native or credit asset). */
export async function getAssetBalance(
  publicKey: string,
  asset: AssetRef,
  signal?: AbortSignal,
): Promise<string> {
  if (isNative(asset)) {
    return getXLMBalance(publicKey, signal);
  }

  const url = `${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    signal,
  });

  if (res.status === 404) {
    return "0";
  }

  if (!res.ok) {
    throw new Error(`Horizon ${res.status}: failed to fetch balance for ${publicKey}`);
  }

  const data = (await res.json()) as {
    balances?: Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }>;
  };

  const found = data.balances?.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_code === asset.code &&
      b.asset_issuer === asset.issuer,
  );

  return found?.balance ?? "0";
}
