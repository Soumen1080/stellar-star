"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { PaymentRequestCheckout } from "@/components/payment/PaymentRequestCheckout";

function PayRequest() {
  const encoded = useSearchParams()?.get("r") ?? "";
  return encoded ? (
    <PaymentRequestCheckout encoded={encoded} />
  ) : (
    <p role="alert" className="text-sm text-red-600">This payment link is incomplete.</p>
  );
}

/**
 * Opens a payment request link (#327). Signing in comes first; the request is
 * checked against live trip data before anything is signed.
 */
export default function PayPage() {
  return (
    <AuthGuard>
      <main className="min-h-screen bg-[#F6F6F6] flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-[#E5E5E5] bg-white p-6">
          <Suspense fallback={<p className="text-sm text-[#888]">Loading…</p>}>
            <PayRequest />
          </Suspense>
        </div>
      </main>
    </AuthGuard>
  );
}
