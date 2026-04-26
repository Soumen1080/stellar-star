"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Twitter, Github, ExternalLink, ArrowUpRight } from "lucide-react";
import { SettleXLogo } from "@/components/ui/Logo";

const footerLinks = {
  Product: [
    { label: "Features", href: "#features" },
    { label: "How It Works", href: "#how-it-works" },
    { label: "Pricing", href: "#pricing" },
    { label: "Changelog", href: "#" },
    { label: "Roadmap", href: "#" },
  ],
  Developers: [
    { label: "Documentation", href: "#" },
    { label: "GitHub", href: "#", external: true },
    { label: "Stellar SDK", href: "https://stellar.org/developers", external: true },
    { label: "Horizon API", href: "https://horizon.stellar.org", external: true },
    { label: "Freighter Wallet", href: "https://freighter.app", external: true },
  ],
  Company: [
    { label: "About", href: "#" },
    { label: "Blog", href: "#" },
    { label: "Contact", href: "#" },
    { label: "Privacy Policy", href: "#" },
    { label: "Terms of Service", href: "#" },
  ],
};

export default function Footer() {
  return (
    <footer className="bg-[#0F0F14] text-white relative overflow-hidden">
      {/* Subtle grid */}
      <div className="absolute inset-0 bg-grid-dark opacity-50 pointer-events-none" />

      {/* Lime radial glow */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-[#2DD4BF]/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-8">
        {/* Top section */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pb-12 border-b border-white/10">
          {/* Brand column */}
          <div className="lg:col-span-4">
            <Link href="/" className="inline-flex mb-4" aria-label="SettleX home">
              <SettleXLogo size="md" variant="dark" />
            </Link>
            <p className="text-[#888] text-sm leading-relaxed max-w-xs mb-6">
              Decentralized bill-splitting on the Stellar blockchain. Split expenses, pay instantly, track transparently.
            </p>

            {/* Social links */}
            <div className="flex items-center gap-3">
              {[
                { icon: Twitter, href: "#", label: "Twitter" },
                { icon: Github, href: "#", label: "GitHub" },
              ].map(({ icon: Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  aria-label={label}
                  className="flex items-center justify-center w-9 h-9 rounded-xl bg-white/5 border border-white/10 text-[#888] hover:text-white hover:border-[#2DD4BF]/40 hover:bg-[#2DD4BF]/10 transition-all duration-200"
                >
                  <Icon size={16} />
                </a>
              ))}
              <a
                href="https://stellar.org"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 h-9 rounded-xl bg-[#2DD4BF]/10 border border-[#2DD4BF]/20 text-[#2DD4BF] text-xs font-medium hover:bg-[#2DD4BF]/20 transition-all duration-200"
              >
                Built on Stellar
                <ExternalLink size={12} />
              </a>
            </div>
          </div>

          {/* Links columns */}
          <div className="lg:col-span-8 grid grid-cols-2 sm:grid-cols-3 gap-8">
            {Object.entries(footerLinks).map(([category, links]) => (
              <div key={category}>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-[#555] mb-4">
                  {category}
                </h4>
                <ul className="space-y-2.5">
                  {links.map((link) => (
                    <li key={link.label}>
                      {"external" in link && link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-sm text-[#888] hover:text-white transition-colors duration-150 group"
                        >
                          {link.label}
                          <ArrowUpRight
                            size={11}
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          />
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-sm text-[#888] hover:text-white transition-colors duration-150"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-8">
          <p className="text-xs text-[#555]">
            © 2026 SettleX. Built on{" "}
            <a
              href="https://stellar.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#2DD4BF] hover:underline"
            >
              Stellar Network
            </a>
            .
          </p>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] animate-pulse" />
            <span className="text-xs text-[#555]">
              Testnet Active
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
