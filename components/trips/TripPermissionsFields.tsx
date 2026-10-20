"use client";

import type { TripPermissions } from "@/types/trip";

interface TripPermissionsFieldsProps {
  value: TripPermissions;
  onChange: (value: TripPermissions) => void;
}

const OPTIONS: Array<{ key: keyof TripPermissions; label: string; hint: string }> = [
  {
    key: "membersCanAddExpenses",
    label: "Members can add expenses",
    hint: "Otherwise only you, the trip creator, can add expenses.",
  },
  {
    key: "membersCanInvite",
    label: "Members can invite people",
    hint: "Otherwise only you can create invite links.",
  },
];

/** What non-creator members may do. The creator can always do both. */
export function TripPermissionsFields({ value, onChange }: TripPermissionsFieldsProps) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-[#0F0F14] mb-2">Permissions</legend>
      <div className="space-y-2">
        {OPTIONS.map((option) => (
          <label key={option.key} className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[#2DD4BF]"
              checked={value[option.key]}
              onChange={(e) => onChange({ ...value, [option.key]: e.target.checked })}
            />
            <span>
              <span className="block text-sm text-[#0F0F14]">{option.label}</span>
              <span className="block text-[11px] text-[#AAA]">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
