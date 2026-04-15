import { HORIZON_URL } from "@/lib/utils/constants";

export async function getXLMBalance(publicKey: string): Promise<string> {
  const url = `${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`;

  const res = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
  });

  if (!res.ok) {
    throw new Error(`Horizon ${res.status}: failed to fetch balance for ${publicKey}`);
  }

  const data = await res.json() as {
    balances?: Array<{ asset_type: string; balance: string }>;
  };

  const native = data.balances?.find((b) => b.asset_type === "native");
  return native?.balance ?? "0";
}
