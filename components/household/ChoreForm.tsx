"use client";

import { useState, type FormEvent } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { HouseholdChoreCadence, HouseholdChoreDraft } from "@/types/householdChore";
import type { Member } from "@/types/expense";

interface ChoreFormProps {
  members: Member[];
  optedOutWallets: string[];
  disabled: boolean;
  onCreate: (draft: HouseholdChoreDraft) => Promise<boolean>;
}

const inputClass =
  "mt-1 w-full rounded-lg border border-[#D9D9D9] bg-white px-3 py-2 text-sm text-[#0F0F14] focus:border-[#2DD4BF] focus:outline-none focus:ring-2 focus:ring-[#2DD4BF]/20";

export function ChoreForm({ members, optedOutWallets, disabled, onCreate }: ChoreFormProps) {
  const { t } = useLocale();
  const today = new Date().toISOString().slice(0, 10);
  const eligibleMembers = members.filter(
    (member): member is Member & { walletAddress: string } =>
      Boolean(member.walletAddress?.trim()) &&
      !optedOutWallets.some((wallet) => wallet.toUpperCase() === member.walletAddress?.toUpperCase()),
  );
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [cadence, setCadence] = useState<HouseholdChoreCadence>("weekly");
  const [nextDueOn, setNextDueOn] = useState(today);
  const [rotationWallets, setRotationWallets] = useState<string[]>(
    eligibleMembers.map((member) => member.walletAddress),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const toggleMember = (walletAddress: string) => {
    setRotationWallets((current) =>
      current.some((wallet) => wallet.toUpperCase() === walletAddress.toUpperCase())
        ? current.filter((wallet) => wallet.toUpperCase() !== walletAddress.toUpperCase())
        : [...current, walletAddress],
    );
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setFormError(t("errors.required"));
      return;
    }
    if (rotationWallets.length === 0) {
      setFormError(t("household.rotationRequired"));
      return;
    }
    setFormError(null);
    const saved = await onCreate({
      title: title.trim(),
      details: details.trim() || undefined,
      cadence,
      rotationWallets,
      nextDueOn,
    });
    if (saved) {
      setTitle("");
      setDetails("");
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded-xl border border-[#E5E5E5] bg-white p-4">
      <label className="block text-sm font-medium text-[#333]">
        {t("household.titleLabel")}
        <input
          required
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={inputClass}
          disabled={disabled}
        />
      </label>
      <label className="block text-sm font-medium text-[#333]">
        {t("household.detailsLabel")}
        <textarea
          maxLength={500}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          className={inputClass}
          rows={2}
          disabled={disabled}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-[#333]">
          {t("household.cadence")}
          <select
            value={cadence}
            onChange={(event) => setCadence(event.target.value as HouseholdChoreCadence)}
            className={inputClass}
            disabled={disabled}
          >
            <option value="weekly">{t("household.weekly")}</option>
            <option value="biweekly">{t("household.biweekly")}</option>
            <option value="monthly">{t("household.monthly")}</option>
          </select>
        </label>
        <label className="block text-sm font-medium text-[#333]">
          {t("household.nextDue")}
          <input
            type="date"
            required
            value={nextDueOn}
            onChange={(event) => setNextDueOn(event.target.value)}
            className={inputClass}
            disabled={disabled}
          />
        </label>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[#333]">{t("household.rotation")}</legend>
        <div className="flex flex-wrap gap-3">
          {eligibleMembers.map((member) => (
            <label key={member.id} className="flex items-center gap-2 text-sm text-[#555]">
              <input
                type="checkbox"
                checked={rotationWallets.some(
                  (wallet) => wallet.toUpperCase() === member.walletAddress.toUpperCase(),
                )}
                onChange={() => toggleMember(member.walletAddress)}
                disabled={disabled}
                className="accent-[#0F0F14]"
              />
              {member.name}
            </label>
          ))}
          {eligibleMembers.length === 0 && (
            <p className="text-sm text-[#777]">{t("household.noEligibleMembers")}</p>
          )}
        </div>
      </fieldset>
      {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
      <button
        type="submit"
        disabled={disabled || rotationWallets.length === 0}
        className="rounded-lg bg-[#0F0F14] px-4 py-2 text-sm font-semibold text-white hover:bg-[#292932] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("household.create")}
      </button>
    </form>
  );
}
