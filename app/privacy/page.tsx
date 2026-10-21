"use client";

import React, { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Shield,
  Lock,
  Database,
  Trash2,
  Download,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ChevronRight,
  ArrowLeft,
  Clock,
  FileText,
} from "lucide-react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/components/ui/Toast";

export default function PrivacyPage() {
  const { user, token, signOut } = useAuth();
  const { isConnected, publicKey, disconnect } = useWallet();
  const { success, error: toastError } = useToast();

  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleExportData = async () => {
    if (!token) {
      toastError("Authentication Required", "Please sign in with your wallet to export your data.");
      return;
    }
    setIsExporting(true);
    try {
      const res = await fetch("/api/account/export", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error("Failed to export account data.");
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stellarstar-data-${publicKey?.slice(0, 8) || "export"}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      success("Export Complete", "Your personal application data has been downloaded.");
    } catch (err: any) {
      toastError("Export Failed", err.message || "Could not complete data export.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!token) {
      toastError("Authentication Required", "Please sign in with your wallet to delete your account.");
      return;
    }
    setIsDeleting(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Failed to delete account.");
      }
      success(
        "Account Deleted",
        "Your off-chain profile and private data have been removed. On-chain transfers remain permanent on Stellar."
      );
      signOut();
      disconnect();
      setConfirmDelete(false);
    } catch (err: any) {
      toastError("Deletion Error", err.message || "Failed to delete account.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-[#0F0F14] flex flex-col justify-between">
      <Header />

      <main className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16 w-full">
        {/* Navigation Breadcrumb */}
        <div className="mb-6 flex items-center gap-2 text-sm text-[#888]">
          <Link href="/" className="hover:text-[#0F0F14] transition-colors flex items-center gap-1">
            <ArrowLeft size={14} /> Home
          </Link>
          <span>/</span>
          <span className="text-[#0F0F14] font-medium">Privacy Notice & Retention</span>
        </div>

        {/* Hero Section */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#2DD4BF]/10 text-[#0F766E] rounded-full text-xs font-semibold mb-4">
            <Shield size={14} /> Non-Custodial Privacy & Retention Model
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4 text-[#0F0F14]">
            Privacy Policy & Data Rights
          </h1>
          <p className="text-base sm:text-lg text-[#666] leading-relaxed max-w-3xl">
            Stellar Star is designed with a privacy-first, non-custodial architecture. We clearly distinguish
            permanent, immutable blockchain records from mutable, deletable off-chain application records.
          </p>
        </div>

        {/* Dual Architecture Comparison */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {/* Card 1: Public Chain Records */}
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm">
            <div className="w-10 h-10 rounded-xl bg-[#0F0F14] text-white flex items-center justify-center mb-4">
              <Lock size={20} />
            </div>
            <h2 className="text-lg font-bold mb-2 flex items-center gap-2">
              Immutable Blockchain Records
              <span className="text-xs font-semibold px-2 py-0.5 bg-amber-100 text-amber-800 rounded-md">Permanent</span>
            </h2>
            <p className="text-sm text-[#666] mb-4">
              Transactions executed on the Stellar ledger are decentralized, immutable, and permanent by network design.
            </p>
            <ul className="text-xs text-[#555] space-y-2 mb-4 font-mono bg-[#F9F9FA] p-3 rounded-xl">
              <li>• Public key addresses (G...)</li>
              <li>• Soroban contract IDs & transactions</li>
              <li>• Payment amounts, assets & ledger sequence numbers</li>
              <li>• Cryptographic Ed25519 signatures</li>
            </ul>
            <p className="text-xs text-[#888] italic">
              * Note: Blockchain records cannot be modified, deleted, or rolled back by Stellar Star or any third party.
            </p>
          </div>

          {/* Card 2: Off-Chain Application Data */}
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm">
            <div className="w-10 h-10 rounded-xl bg-[#2DD4BF]/20 text-[#0F766E] flex items-center justify-center mb-4">
              <Database size={20} />
            </div>
            <h2 className="text-lg font-bold mb-2 flex items-center gap-2">
              Mutable Application Data
              <span className="text-xs font-semibold px-2 py-0.5 bg-teal-100 text-teal-800 rounded-md">Deletable</span>
            </h2>
            <p className="text-sm text-[#666] mb-4">
              Personal application context is stored off-chain in encrypted storage and protected by Row-Level Security (RLS).
            </p>
            <ul className="text-xs text-[#555] space-y-2 mb-4 font-mono bg-[#F9F9FA] p-3 rounded-xl">
              <li>• Profile display names & contact books</li>
              <li>• Trip titles, notes & expense descriptions</li>
              <li>• Uploaded receipt scans & PDF attachments</li>
              <li>• Capability invite links & session tokens</li>
            </ul>
            <p className="text-xs text-[#888] italic">
              * Fully under your control: you can export or delete this data at any time via authenticated request.
            </p>
          </div>
        </div>

        {/* Data Retention Schedule Table */}
        <section className="mb-12 bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Clock size={20} className="text-[#0F766E]" />
            Official Retention Schedule
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-[#EEE] text-xs font-semibold text-[#888] uppercase tracking-wider">
                  <th className="py-3 px-2">Data Category</th>
                  <th className="py-3 px-2">Storage Layer</th>
                  <th className="py-3 px-2">Retention Period</th>
                  <th className="py-3 px-2">Deletion Mechanism</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0F0F0] text-xs text-[#444]">
                <tr>
                  <td className="py-3 px-2 font-medium text-[#0F0F14]">User Profile</td>
                  <td className="py-3 px-2">Database (`users`)</td>
                  <td className="py-3 px-2">Retained while active</td>
                  <td className="py-3 px-2">Purged on account deletion</td>
                </tr>
                <tr>
                  <td className="py-3 px-2 font-medium text-[#0F0F14]">Receipt Attachments</td>
                  <td className="py-3 px-2">Private Storage</td>
                  <td className="py-3 px-2">Up to 730 days</td>
                  <td className="py-3 px-2">Automated sweep or user delete</td>
                </tr>
                <tr>
                  <td className="py-3 px-2 font-medium text-[#0F0F14]">Trip Invitations</td>
                  <td className="py-3 px-2">Database (`trip_invites`)</td>
                  <td className="py-3 px-2">7 days default</td>
                  <td className="py-3 px-2">Immediate revoke; 30d cleanup</td>
                </tr>
                <tr>
                  <td className="py-3 px-2 font-medium text-[#0F0F14]">Audit & Export Logs</td>
                  <td className="py-3 px-2">Database (`audit_events`)</td>
                  <td className="py-3 px-2">90 days</td>
                  <td className="py-3 px-2">Rolling automated purge</td>
                </tr>
                <tr>
                  <td className="py-3 px-2 font-medium text-[#0F0F14]">Auth Challenges</td>
                  <td className="py-3 px-2">Database (`auth_challenges`)</td>
                  <td className="py-3 px-2">5 minutes</td>
                  <td className="py-3 px-2">Purged upon verification</td>
                </tr>
                <tr>
                  <td className="py-3 px-2 font-medium text-[#0F0F14]">Database Backups</td>
                  <td className="py-3 px-2">Encrypted Storage</td>
                  <td className="py-3 px-2">30 days</td>
                  <td className="py-3 px-2">Rolling backup cycle rotation</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Data Rights & Account Management Section */}
        <section className="bg-white border border-[#E5E5E5] rounded-2xl p-6 sm:p-8 shadow-sm mb-12">
          <h2 className="text-xl font-bold mb-2 text-[#0F0F14]">Manage Your Data & Account</h2>
          <p className="text-sm text-[#666] mb-6">
            Exercise your right to data portability and right to erasure. Actions below require a verified session from
            your connected wallet.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Export Panel */}
            <div className="p-5 border border-[#EBEBEB] rounded-xl bg-[#FAFAFA] flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 font-semibold text-sm mb-2 text-[#0F0F14]">
                  <Download size={16} className="text-[#0F766E]" /> Export Your Data
                </div>
                <p className="text-xs text-[#666] mb-4 leading-relaxed">
                  Download a structured JSON archive of your personal profile, trips, expense participations, and contacts.
                </p>
              </div>
              <button
                onClick={handleExportData}
                disabled={isExporting}
                className="w-full py-2.5 px-4 bg-white border border-[#D5D5D5] hover:bg-[#F2F2F2] text-xs font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {isExporting ? "Generating Export..." : "Download Data Archive"}
              </button>
            </div>

            {/* Deletion Panel */}
            <div className="p-5 border border-red-100 rounded-xl bg-red-50/40 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 font-semibold text-sm mb-2 text-red-700">
                  <Trash2 size={16} /> Delete Account & Off-Chain Data
                </div>
                <p className="text-xs text-[#666] mb-4 leading-relaxed">
                  Permanently deletes your profile, contact books, and receipts, while anonymizing group participation.
                  Stale sessions are immediately invalidated.
                </p>
              </div>

              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="w-full py-2.5 px-4 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-xs font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  Request Account Deletion
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-red-600 font-medium">Are you sure? This cannot be undone.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDeleteAccount}
                      disabled={isDeleting}
                      className="flex-1 py-2 px-3 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors"
                    >
                      {isDeleting ? "Deleting..." : "Confirm Delete"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="py-2 px-3 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs font-semibold rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
