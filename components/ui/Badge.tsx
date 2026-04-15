import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 font-semibold transition-all",
  {
    variants: {
      variant: {
        lime: "px-3 py-1 bg-[#2DD4BF]/20 text-[#134E4A] text-xs rounded-full border border-[#2DD4BF]/40",
        dark: "px-3 py-1 bg-white/10 text-white text-xs rounded-full border border-white/10",
        outline: "px-3 py-1 bg-transparent text-[#0F0F14] text-xs rounded-full border border-[#E5E5E5]",
        solid: "px-3 py-1 bg-[#2DD4BF] text-[#0F0F14] text-xs rounded-full",
        white: "px-3 py-1 bg-white text-[#0F0F14] text-xs rounded-full shadow-sm",
      },
    },
    defaultVariants: {
      variant: "lime",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
