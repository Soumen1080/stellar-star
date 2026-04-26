"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, LogOut, User, LayoutDashboard, Receipt, Map, ChevronDown, Copy } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useAuth } from "@/context/AuthContext";
import { cn, formatAddress } from "@/lib/utils";
import { SettleXLogo } from "@/components/ui/Logo";

const navLinks = [
  { label: "Features", href: "#features" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
];

export default function Header() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { isConnected, publicKey, disconnect } = useWallet();
  const { user, isAuthenticated, signOut } = useAuth();

  const handleSignOut = () => {
    signOut();
    disconnect();
    setUserMenuOpen(false);
    setMobileOpen(false);
  };

  const copyAddress = () => {
    if (publicKey) {
      navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 16);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <motion.header
        initial={{ y: -80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "fixed top-0 left-0 right-0 z-50 transition-all duration-300",
          isScrolled
            ? "top-3 mx-4 sm:mx-6 lg:mx-8"
            : "top-0 mx-0"
        )}
      >
        <div
          className={cn(
            "transition-all duration-300",
            isScrolled
              ? "bg-white/90 backdrop-blur-xl border border-[#E5E5E5] rounded-2xl shadow-[0_4px_32px_-8px_rgba(0,0,0,0.12)]"
              : "bg-white/80 backdrop-blur-sm border-b border-[#E5E5E5]/60"
          )}
        >
          <div className="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              {/* Logo */}
              <Link href="/" className="group" aria-label="SettleX home">
                <SettleXLogo
                  size="md"
                  className="group-hover:opacity-90 transition-opacity duration-150"
                />
              </Link>

              {/* Desktop Nav */}
              <nav className="hidden md:flex items-center gap-1">
                {navLinks.map((link) => (
                  <Link
                    key={link.label}
                    href={link.href}
                    className="px-4 py-2 text-sm font-medium text-[#555] hover:text-[#0F0F14] rounded-xl hover:bg-black/5 transition-all duration-150"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>

              {/* Desktop CTA */}
              <div className="hidden md:flex items-center gap-3">
                {isAuthenticated ? (
                  <div ref={userMenuRef} className="relative">
                    {/* Trigger button */}
                    <button
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-black/5 hover:bg-black/10 rounded-xl transition-all duration-150"
                    >
                      <div className="w-7 h-7 rounded-lg bg-[#2DD4BF] flex items-center justify-center">
                        <User size={14} className="text-[#0F0F14]" />
                      </div>
                      <span className="text-sm font-semibold text-[#0F0F14]">
                        {user?.displayName || (publicKey ? formatAddress(publicKey, 4) : '')}
                      </span>
                      <ChevronDown
                        size={14}
                        className={cn("text-[#888] transition-transform duration-200", userMenuOpen && "rotate-180")}
                      />
                    </button>

                    {/* Dropdown */}
                    <AnimatePresence>
                      {userMenuOpen && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.96, y: -6 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.96, y: -6 }}
                          transition={{ duration: 0.15, ease: "easeOut" }}
                          className="absolute right-0 mt-2 w-60 bg-white border border-[#E5E5E5] rounded-2xl shadow-[0_8px_40px_-8px_rgba(0,0,0,0.18)] overflow-hidden z-50"
                        >
                          {/* Wallet address */}
                          <div className="px-4 pt-4 pb-3 border-b border-[#F0F0F0]">
                            <p className="text-xs font-semibold text-[#888] uppercase tracking-wider mb-1.5">Wallet</p>
                            <button
                              onClick={copyAddress}
                              className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[#F6F6F6] hover:bg-[#EDEDED] rounded-lg transition-all group"
                            >
                              <span className="text-xs font-mono text-[#0F0F14] truncate flex-1 text-left">
                                {publicKey ? formatAddress(publicKey, 8) : ''}
                              </span>
                              <Copy size={12} className="text-[#888] group-hover:text-[#0F0F14] shrink-0" />
                            </button>
                            {copied && <p className="text-xs text-[#134E4A] mt-1 text-center">Copied!</p>}
                          </div>

                          {/* Navigation links */}
                          <div className="px-2 py-2">
                            <Link
                              href="/dashboard"
                              onClick={() => setUserMenuOpen(false)}
                              className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#0F0F14] hover:bg-[#F6F6F6] rounded-xl transition-all"
                            >
                              <LayoutDashboard size={16} className="text-[#555]" />
                              Dashboard
                            </Link>
                            <Link
                              href="/expenses"
                              onClick={() => setUserMenuOpen(false)}
                              className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#0F0F14] hover:bg-[#F6F6F6] rounded-xl transition-all"
                            >
                              <Receipt size={16} className="text-[#555]" />
                              Expenses
                            </Link>
                            <Link
                              href="/trips"
                              onClick={() => setUserMenuOpen(false)}
                              className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#0F0F14] hover:bg-[#F6F6F6] rounded-xl transition-all"
                            >
                              <Map size={16} className="text-[#555]" />
                              Trips
                            </Link>
                          </div>

                          {/* Logout */}
                          <div className="px-2 pb-2 border-t border-[#F0F0F0] pt-1">
                            <button
                              onClick={handleSignOut}
                              className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#FF6B6B] hover:bg-[#FF6B6B]/8 rounded-xl transition-all"
                            >
                              <LogOut size={16} />
                              Sign Out
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ) : (
                  <Link
                    href="/auth"
                    className="px-4 py-2 text-sm font-semibold text-white bg-[#0F0F14] hover:bg-[#333] rounded-xl transition-all"
                  >
                    Sign In
                  </Link>
                )}
              </div>

              {/* Mobile Hamburger */}
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="md:hidden flex items-center justify-center w-9 h-9 rounded-xl hover:bg-black/5 transition-all"
                aria-label="Toggle menu"
              >
                {mobileOpen ? (
                  <X size={20} className="text-[#0F0F14]" />
                ) : (
                  <Menu size={20} className="text-[#0F0F14]" />
                )}
              </button>
            </div>
          </div>
        </div>
      </motion.header>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed top-20 left-4 right-4 z-40 bg-white rounded-2xl border border-[#E5E5E5] shadow-[0_8px_40px_-8px_rgba(0,0,0,0.15)] p-4"
          >
            <nav className="flex flex-col gap-1 mb-4">
              {navLinks.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-2.5 text-sm font-medium text-[#555] hover:text-[#0F0F14] rounded-xl hover:bg-black/5 transition-all"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
            <div className="flex flex-col gap-2 pt-3 border-t border-[#E5E5E5]">
              {isAuthenticated ? (
                <>
                  {/* User info */}
                  <div className="flex items-center gap-3 px-3 py-2.5 bg-[#F6F6F6] rounded-xl">
                    <div className="w-8 h-8 rounded-lg bg-[#2DD4BF] flex items-center justify-center shrink-0">
                      <User size={14} className="text-[#0F0F14]" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#0F0F14] truncate">
                        {user?.displayName || (publicKey ? formatAddress(publicKey, 4) : '')}
                      </p>
                      <p className="text-xs text-[#888] font-mono truncate">
                        {publicKey ? formatAddress(publicKey, 8) : ''}
                      </p>
                    </div>
                  </div>
                  {/* Nav links */}
                  <Link
                    href="/dashboard"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#0F0F14] hover:bg-black/5 rounded-xl transition-all"
                  >
                    <LayoutDashboard size={16} className="text-[#555]" />
                    Dashboard
                  </Link>
                  <Link
                    href="/expenses"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#0F0F14] hover:bg-black/5 rounded-xl transition-all"
                  >
                    <Receipt size={16} className="text-[#555]" />
                    Expenses
                  </Link>
                  <Link
                    href="/trips"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#0F0F14] hover:bg-black/5 rounded-xl transition-all"
                  >
                    <Map size={16} className="text-[#555]" />
                    Trips
                  </Link>
                  <button
                    onClick={handleSignOut}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-[#FF6B6B] hover:bg-[#FF6B6B]/8 rounded-xl transition-all w-full"
                  >
                    <LogOut size={16} />
                    Sign Out
                  </button>
                </>
              ) : (
                <Link
                  href="/auth"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-sm font-semibold text-center text-white bg-[#0F0F14] hover:bg-[#333] rounded-xl transition-all w-full"
                >
                  Sign In
                </Link>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
