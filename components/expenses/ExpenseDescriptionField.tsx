"use client";

import { Textarea } from "@/components/ui/Input";

interface ExpenseDescriptionFieldProps {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}

export function ExpenseDescriptionField({ value, onChange, maxLength = 100 }: ExpenseDescriptionFieldProps) {
  const counterClass =
    value.length >= maxLength ? "text-red-500" : value.length >= maxLength * 0.8 ? "text-amber-500" : "text-[#CCC]";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-[#444] uppercase tracking-wide">
          Description
        </label>
        <span className={`text-[10px] font-medium tabular-nums ${counterClass}`}>
          {value.length}/{maxLength}
        </span>
      </div>
      <Textarea
        placeholder="Add a short note about this expense..."
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
