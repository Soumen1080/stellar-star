import type { Metadata } from "next";
import Link from "next/link";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Accessibility Statement",
  description: "Accessibility commitment and feedback contact for Stellar-star.",
};

export default function AccessibilityPage() {
  return (
    <>
      <Header />
      <main id="main-content" className="mx-auto max-w-3xl px-5 py-16 text-[#0F0F14]">
        <h1 className="text-3xl font-bold">Accessibility statement</h1>
        <p className="mt-4 leading-7">
          Stellar-star aims to make its wallet, authentication, trip, expense, payment, and recovery flows usable by everyone. We are working toward WCAG 2.2 Level AA, including keyboard access, clear focus, readable labels and errors, sufficient contrast, and reduced-motion support.
        </p>
        <h2 className="mt-8 text-xl font-semibold">Known limitations and feedback</h2>
        <p className="mt-3 leading-7">
          Some third-party wallet interfaces may have accessibility limitations that Stellar-star cannot directly change. If you encounter a barrier or need information in another format, contact{" "}
          <a className="font-semibold text-[#0F766E] underline underline-offset-2" href="mailto:privacy@stellarstar.app">privacy@stellarstar.app</a>.
          Please include the page and assistive technology or browser involved if you can.
        </p>
        <p className="mt-6"><Link className="text-[#0F766E] underline underline-offset-2" href="/">Return to Stellar-star</Link></p>
      </main>
      <Footer />
    </>
  );
}
