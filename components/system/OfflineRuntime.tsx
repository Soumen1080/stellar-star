"use client";

import { useEffect, useState } from "react";
import { useWalletContext } from "@/context/WalletContext";
import { LAST_SYNC_PREFIX } from "@/lib/supabase/cacheInvalidation";

export function OfflineRuntime() {
  const { publicKey } = useWalletContext();
  const [online, setOnline] = useState(true);
  const [lastSynced, setLastSynced] = useState<string | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") void navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);

  useEffect(() => {
    if (!publicKey) { setLastSynced(null); return; }
    const refresh = () => { try { setLastSynced(localStorage.getItem(`${LAST_SYNC_PREFIX}${publicKey}`)); } catch { setLastSynced(null); } };
    refresh();
    window.addEventListener("stellar-star:last-synced", refresh);
    return () => window.removeEventListener("stellar-star:last-synced", refresh);
  }, [publicKey]);

  return (
    <div className="fixed bottom-3 left-3 z-[80] rounded-full border border-black/10 bg-white/95 px-3 py-1.5 text-xs text-[#333] shadow" role="status" aria-live="polite">
      <span>{online ? "Online" : "Offline · expense drafts can queue; payments require a connection"}</span>
      {publicKey && lastSynced && <span> · Last synced {new Date(lastSynced).toLocaleString()}</span>}
    </div>
  );
}
