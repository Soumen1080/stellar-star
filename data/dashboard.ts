import { Contact, Map, QrCode, ReceiptText, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface DashboardFeature {
  icon: LucideIcon;
  title: string;
  desc: string;
  href: string;
  badge: string;
}

export function getDashboardFeatures(expenseCount: number, tripCount: number): DashboardFeature[] {
  return [
    {
      icon: ReceiptText,
      title: "Expenses",
      desc: "Add bills & split them instantly.",
      href: "/expenses",
      badge: `${expenseCount}`,
    },
    {
      icon: Zap,
      title: "Pay via XLM",
      desc: "Sign payments with Freighter.",
      href: "/expenses",
      badge: "Live",
    },
    {
      icon: QrCode,
      title: "QR Payments",
      desc: "SEP-0007 QR codes for any Stellar wallet.",
      href: "/expenses",
      badge: "Live",
    },
    {
      icon: Map,
      title: "Trip Mode",
      desc: "Group expenses & settle as a team.",
      href: "/trips",
      badge: `${tripCount}`,
    },
    {
      icon: Contact,
      title: "Contacts",
      desc: "Saved people & verified wallets.",
      href: "/contacts",
      badge: "New",
    },
  ];
}
