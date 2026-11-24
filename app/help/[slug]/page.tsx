import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { HelpArticleBody } from "@/lib/help/render";
import { formatHelpDate, getHelpArticle, getHelpArticles } from "@/lib/help/articles";

export const dynamic = "force-static";
export const dynamicParams = false;

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getHelpArticles().map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const article = getHelpArticle((await params).slug);
  if (!article) return { title: "Help article not found | Stellar-star" };
  return { title: `${article.title} | Stellar-star Help`, description: article.summary };
}

export default async function HelpArticlePage({ params }: Params) {
  const article = getHelpArticle((await params).slug);
  if (!article) notFound();

  const related = getHelpArticles()
    .filter((other) => other.slug !== article.slug)
    .map((other) => ({
      other,
      shared:
        (other.category === article.category ? 2 : 0) +
        other.tags.filter((tag) => article.tags.includes(tag)).length,
    }))
    .filter(({ shared }) => shared > 0)
    .sort((a, b) => b.shared - a.shared || a.other.title.localeCompare(b.other.title))
    .slice(0, 3)
    .map(({ other }) => other);

  const toc = article.headings.filter((h) => h.level === 2);

  return (
    <>
      <Header />
      <main id="main-content" className="mx-auto max-w-3xl px-4 pb-20 pt-28 text-[#0F0F14] sm:px-6">
        <Link
          href="/help"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0F766E] underline-offset-2 hover:underline"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Help Center
        </Link>

        <article className="mt-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-[#555]">{article.category}</p>
          <h1 className="mt-1 text-3xl font-bold">{article.title}</h1>
          <p className="mt-3 text-lg leading-7 text-[#444]">{article.summary}</p>

          <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-1 border-y border-[#E5E5E5] py-3 text-sm text-[#555]">
            <div className="flex gap-1.5">
              <dt>Version</dt>
              <dd className="font-medium text-[#0F0F14]">{article.version}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Updated</dt>
              <dd className="font-medium text-[#0F0F14]">
                <time dateTime={article.updated}>{formatHelpDate(article.updated)}</time>
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Owner</dt>
              <dd className="font-medium text-[#0F0F14]">{article.owner}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Next review</dt>
              <dd className="font-medium text-[#0F0F14]">
                <time dateTime={article.reviewBy}>{formatHelpDate(article.reviewBy)}</time>
              </dd>
            </div>
          </dl>

          {toc.length > 1 ? (
            <nav aria-label="On this page" className="mt-6 rounded-xl bg-white p-4 text-sm shadow-sm">
              <p className="font-semibold">On this page</p>
              <ul className="mt-2 space-y-1">
                {toc.map((heading) => (
                  <li key={heading.id}>
                    <a href={`#${heading.id}`} className="text-[#0F766E] underline-offset-2 hover:underline">
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <div className="mt-8">
            <HelpArticleBody blocks={article.blocks} />
          </div>
        </article>

        {related.length > 0 ? (
          <aside className="mt-12 border-t border-[#E5E5E5] pt-8" aria-labelledby="related-heading">
            <h2 id="related-heading" className="text-lg font-semibold">
              Related articles
            </h2>
            <ul className="mt-3 space-y-2">
              {related.map((other) => (
                <li key={other.slug}>
                  <Link href={`/help/${other.slug}`} className="font-semibold text-[#0F766E] underline underline-offset-2">
                    {other.title}
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <p className="mt-10 text-sm text-[#555]">
          Still stuck? Check{" "}
          <Link href="/status" className="font-semibold text-[#0F766E] underline underline-offset-2">
            system status
          </Link>{" "}
          to see if there’s a known problem.
        </p>
      </main>
      <Footer />
    </>
  );
}
