import Link from "next/link";
import { Zap, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#F6F6F6] flex flex-col items-center justify-center px-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-[#2DD4BF] flex items-center justify-center mb-6 shadow-[0_4px_24px_-4px_rgba(185,255,102,0.5)]">
        <Zap size={28} className="text-[#0F0F14] fill-[#0F0F14]" />
      </div>

      <p className="text-[6rem] font-black leading-none text-[#0F0F14] mb-2">404</p>
      <h1 className="text-xl font-bold text-[#0F0F14] mb-2">Page not found</h1>
      <p className="text-sm text-[#888] mb-8 max-w-xs">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>

      <Link
        href="/"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all"
      >
        <ArrowLeft size={14} />
        Back to Home
      </Link>
    </div>
  );
}
