"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/hooks/useWallet";
import { Spinner } from "@/components/ui/Spinner";

interface WalletGuardProps {
  children: React.ReactNode;
  /** Where to redirect when wallet is not connected (default: "/") */
  redirectTo?: string;
}

/**
 * Client-side route guard.
 * Renders `children` only when a wallet is connected.
 * Redirects to `redirectTo` otherwise, showing a brief loading state
 * while the auto-reconnect check runs on mount.
 */
export function WalletGuard({
  children,
  redirectTo = "/",
}: WalletGuardProps) {
  const { isConnected, isConnecting, isHydrated } = useWallet();
  const router = useRouter();

  useEffect(() => {
    // Wait until the localStorage auto-reconnect check has fully resolved
    // before deciding to redirect. Without this, a page refresh would always
    // redirect to home because isConnected starts as false while the async
    // Freighter check is pending.
    if (isHydrated && !isConnecting && !isConnected) {
      router.replace(redirectTo);
    }
  }, [isConnected, isConnecting, isHydrated, redirectTo, router]);

  // Show spinner while hydrating (restoring from localStorage) or connecting
  if (!isHydrated || isConnecting || !isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F6F6F6]">
        <div className="flex flex-col items-center gap-4">
          <Spinner size={28} className="text-[#2DD4BF]" />
          <p className="text-sm font-medium text-[#888]">
            {isConnecting ? "Connecting wallet…" : "Checking wallet…"}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
