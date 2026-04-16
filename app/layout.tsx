import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/context/WalletContext";
import { AuthProvider } from "@/context/AuthContext";
import { ToastProvider } from "@/components/ui/Toast";
import { ExpenseProvider } from "@/context/ExpenseContext";
import { TripProvider } from "@/context/TripContext";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://settle-x-pi.vercel.app";

const metadataBase = (() => {
  try {
    return new URL(siteUrl);
  } catch {
    return new URL("http://localhost:3000");
  }
})();

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "Stellar Star — Split Bills on the Stellar Blockchain",
    template: "%s | Stellar Star",
  },
  description:
    "Stellar Star is a decentralized bill-splitting app built on the Stellar blockchain. Split expenses, pay instantly with XLM, track with QR codes — all trustless, all transparent.",
  keywords: [
    "Stellar",
    "blockchain",
    "bill splitting",
    "crypto payments",
    "XLM",
    "Freighter wallet",
    "decentralized",
    "group expenses",
    "web3",
  ],
  authors: [{ name: "Stellar Star Team" }],
  creator: "Stellar Star",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Stellar Star",
    title: "Stellar Star — Split Bills on the Stellar Blockchain",
    description:
      "Decentralized bill-splitting powered by Stellar. Split instantly, pay transparently.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Stellar Star — Split Bills on Stellar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Stellar Star — Split Bills on the Stellar Blockchain",
    description: "Decentralized bill-splitting powered by Stellar.",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#2DD4BF",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className={`${poppins.className} bg-[#F6F6F6] text-[#0F0F14] font-sans antialiased`}>
        <ToastProvider>
          <WalletProvider>
            <AuthProvider>
              <ExpenseProvider>
                <TripProvider>
                  {children}
                </TripProvider>
              </ExpenseProvider>
            </AuthProvider>
          </WalletProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
