import { Spinner } from "@/components/ui/Spinner";

export default function Loading() {
  return (
    <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center">
      <Spinner size={32} className="text-[#2DD4BF]" />
    </div>
  );
}
