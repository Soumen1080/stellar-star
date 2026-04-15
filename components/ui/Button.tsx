"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-[#2DD4BF] text-[#0F0F14] hover:bg-[#14B8A6] hover:shadow-[0_4px_24px_-4px_rgba(185,255,102,0.45)] hover:-translate-y-0.5",
        secondary:
          "bg-white text-[#0F0F14] border border-[#E5E5E5] hover:border-[#2DD4BF] hover:shadow-[0_4px_20px_-6px_rgba(0,0,0,0.12)] hover:-translate-y-0.5",
        dark: "bg-[#0F0F14] text-white hover:bg-[#1A1A22] hover:-translate-y-0.5 hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.4)]",
        ghost: "text-[#0F0F14] hover:bg-black/5",
        "ghost-white": "text-white hover:bg-white/10",
        outline:
          "border border-[#0F0F14] text-[#0F0F14] hover:bg-[#0F0F14] hover:text-white",
        "outline-lime":
          "border border-[#2DD4BF] text-[#2DD4BF] hover:bg-[#2DD4BF] hover:text-[#0F0F14]",
        destructive: "bg-red-500 text-white hover:bg-red-600",
      },
      size: {
        sm: "px-4 py-2 text-sm rounded-xl",
        md: "px-6 py-3 text-sm rounded-2xl",
        lg: "px-8 py-4 text-base rounded-2xl",
        xl: "px-10 py-5 text-lg rounded-2xl",
        icon: "h-10 w-10 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={loading || props.disabled}
        {...props}
      >
        {loading ? (
          <>
            <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
