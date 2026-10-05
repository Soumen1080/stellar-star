"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

interface TripSearchProps {
  value: string;
  onSearchChange: (value: string) => void;
  delayMs?: number;
}

export function TripSearch({ value, onSearchChange, delayMs = 300 }: TripSearchProps) {
  const [draft, setDraft] = useState(value);
  const debouncedDraft = useDebouncedValue(draft, delayMs);

  useEffect(() => onSearchChange(debouncedDraft), [debouncedDraft, onSearchChange]);

  const clear = () => {
    setDraft("");
    onSearchChange("");
  };

  return (
    <div role="search" className="relative mb-4" aria-label="Search trips">
      <Search
        aria-hidden="true"
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#AAA]"
      />
      <label htmlFor="trip-search" className="sr-only">Search trips</label>
      <input
        id="trip-search"
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search trips or members"
        autoComplete="off"
        className="w-full rounded-xl border border-[#E5E5E5] bg-white py-2.5 pl-9 pr-10 text-sm text-[#0F0F14] outline-none transition-colors placeholder:text-[#AAA] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/15"
      />
      {draft && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear trip search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#888] hover:bg-[#F0F0F0] hover:text-[#0F0F14]"
        >
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}
