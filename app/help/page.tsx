import type { Metadata } from "next";
import Link from "next/link";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { HelpSearch } from "@/components/help/HelpSearch";
import { buildHelpSearchIndex, getHelpArticles, groupHelpArticles } from "@/lib/help/articles";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Help Center | Stellar-star",
  description:
    "Answers about wallet setup, invitations, payments, transaction lookup, corrections, privacy and staying safe.",
};

export default function HelpCenterPage() {
  const articles = getHelpArticles();
  return (
    <>
      <Header />
      <main id="main-content" className="mx-auto max-w-4xl px-4 pb-20 pt-28 text-[#0F0F14] sm:px-6">
        <h1 className="text-3xl font-bold sm:text-4xl">Help Center</h1>
        <p className="mt-3 max-w-2xl leading-7 text-[#444]">
          Answers to everyday questions about wallets, payments and your data. If something isn’t
          working right now, check{" "}
          <Link href="/status" className="font-semibold text-[#0F766E] underline underline-offset-2">
            system status
          </Link>{" "}
          first.
        </p>
        <div className="mt-8">
          <HelpSearch index={buildHelpSearchIndex(articles)} groups={groupHelpArticles(articles)} />
        </div>
      </main>
      <Footer />
    </>
  );
}
