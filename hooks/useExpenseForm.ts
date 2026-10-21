"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useExpense } from "@/hooks/useExpense";
import { useLocale } from "@/context/LocaleContext";
import { parseLocaleAmount } from "@/lib/i18n/parseAmount";
import {
  calculateSplit,
  findDuplicateWalletErrors,
  isValidStellarAddress,
} from "@/lib/split/calculator";
import { validateAmount } from "@/lib/expense/validation";
import type { Expense, Member, SplitMode } from "@/types/expense";
import { fetchExchangeRate } from "@/lib/fx/quote";
import {
  QUOTE_STATE_MESSAGES,
  SETTLEMENT_ASSET_CODE,
  buildProvenance,
  canSubmitWith,
  isSettlementCurrency,
  quoteState,
  settlementAmountFor,
  type LockedQuote,
} from "@/lib/fx/quoteLock";
import { Money } from "@/lib/money";
import { isExpenseCategory, type ExpenseCategory } from "@/lib/expense/categories";
import { parseTagInput, validateTags } from "@/lib/expense/tags";
import { trackAnalyticsEvent } from "@/lib/analytics/sink";

/** Prefill for the form, e.g. from a trip's recurring expense rule. */
export interface ExpenseFormInitialValues {
  title?: string;
  totalAmount?: string;
  splitMode?: SplitMode;
  paidByMemberId?: string;
}

/** Wait this long after the last edit before fetching a quote automatically. */
const QUOTE_DEBOUNCE_MS = 400;
/** How often the form re-checks whether the locked quote has expired. */
const QUOTE_EXPIRY_TICK_MS = 15_000;

async function lockQuote(currency: string): Promise<LockedQuote | null> {
  const quote = await fetchExchangeRate(currency);
  if (!quote) return null;
  return {
    from: currency.toUpperCase(),
    to: SETTLEMENT_ASSET_CODE,
    rate: quote.rate,
    source: quote.source ?? "unknown",
    fetchedAt: quote.fetchedAtIso,
    lockedAt: new Date().toISOString(),
    stale: quote.stale,
    spreadBps: quote.spreadBps,
    providers: quote.providers,
  };
}

export interface UseExpenseFormOptions {
  /** Optional review gate for receipt-assisted drafts. */
  beforeCreate?: () => boolean | Promise<boolean>;
  onSuccess?: (expenseId?: string) => void;
  currentUserPublicKey?: string | null;
  currentUserName?: string | null;
  defaultMembers?: Member[];
  /** Pre-fill, e.g. from a recurring draft. The user still reviews and submits. */
  initialValues?: ExpenseFormInitialValues;
}

export interface ExpenseFormInitialValues {
  title?: string;
  description?: string | null;
  totalAmount?: string;
  currency?: string;
  splitMode?: SplitMode;
  paidByMemberId?: string;
  category?: ExpenseCategory | null;
  tags?: string[];
}

interface ExpenseFormValidationInput {
  title: string;
  totalAmount: string;
  currency: string;
  members: Member[];
  /** Normalized tags; optional so existing callers keep validating as before. */
  tags?: string[];
  locale?: string;
}

export function blankExpenseMember(): Member {
  return { id: crypto.randomUUID(), name: "", walletAddress: "", weight: 1 };
}

export function validateExpenseFormFields({
  title,
  totalAmount,
  currency,
  members,
  tags = [],
  locale = "en-US",
}: ExpenseFormValidationInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!title.trim()) errors.title = "Title is required.";

  const tagError = validateTags(tags);
  if (tagError) errors.tags = tagError;

  const amountError = validateAmount(totalAmount, currency, locale);
  if (amountError) {
    errors.totalAmount = amountError;
  }

  members.forEach((member, index) => {
    if (!member.name.trim()) {
      errors[`member_name_${index}`] = "Name is required.";
    }

    const raw = member.walletAddress?.trim() ?? "";
    if (raw && !isValidStellarAddress(raw)) {
      errors[`member_addr_${index}`] = "Invalid Stellar address (must start with G, 56 chars).";
    }
  });

  const duplicateErrors = findDuplicateWalletErrors(members.map((member) => member.walletAddress));
  Object.entries(duplicateErrors).forEach(([index, message]) => {
    errors[`member_addr_${index}`] = message;
  });

  if (members.filter((member) => member.name.trim()).length < 2) {
    errors.members = "Add at least 2 members.";
  }

  return errors;
}



export function useExpenseForm({
  beforeCreate,
  onSuccess,
  currentUserPublicKey,
  currentUserName,
  defaultMembers,
  initialValues,
}: UseExpenseFormOptions) {
  const { addExpense } = useExpense();
  const { success: toastSuccess, error: toastError } = useToast();
  const { locale } = useLocale();
  const initialMembersRef = useRef<Member[] | null>(null);

  if (!initialMembersRef.current) {
    initialMembersRef.current = resolveInitialMembers(defaultMembers, currentUserName, currentUserPublicKey);
  }

  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");
  const [totalAmount, setTotalAmount] = useState(initialValues?.totalAmount ?? "");
  const [currency, setCurrency] = useState(initialValues?.currency ?? "XLM");
  const [category, setCategoryState] = useState<ExpenseCategory | "">(initialValues?.category ?? "");
  const [tagsInput, setTagsInput] = useState((initialValues?.tags ?? []).join(", "));
  const [splitMode, setSplitMode] = useState<SplitMode>(initialValues?.splitMode ?? "equal");
  const [members, setMembers] = useState<Member[]>(initialMembersRef.current!);
  const [paidByMemberId, setPaidByMemberId] = useState(
    initialMembersRef.current!.some((member) => member.id === initialValues?.paidByMemberId)
      ? initialValues!.paidByMemberId!
      : initialMembersRef.current![0]?.id ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const saveInFlight = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Locked FX quote (#323) ────────────────────────────────────────────────
  // The quote on screen is the quote that is saved: submit never re-fetches a
  // different rate behind the user's back.
  const [quote, setQuote] = useState<LockedQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  const inFlightQuote = useRef<Promise<LockedQuote | null> | null>(null);

  const refreshQuote = useCallback(async (): Promise<LockedQuote | null> => {
    const forCurrency = currencyRef.current;
    if (isSettlementCurrency(forCurrency)) return null;
    setQuoteLoading(true);
    setQuoteFailed(false);
    setErrors(({ quote: _stale, ...rest }) => rest);
    const pending = lockQuote(forCurrency);
    inFlightQuote.current = pending;
    const locked = await pending;
    if (inFlightQuote.current === pending) inFlightQuote.current = null;
    // Ignore a late answer for a currency the user has since switched away from.
    if (currencyRef.current !== forCurrency) return null;
    setQuote(locked);
    setQuoteFailed(locked === null);
    setQuoteLoading(false);
    setNow(Date.now());
    return locked;
  }, []);

  // A new currency invalidates the old quote; fetch one once typing settles.
  useEffect(() => {
    setQuote(null);
    setQuoteFailed(false);
    setQuoteLoading(false);
    setErrors(({ quote: _stale, ...rest }) => rest);
    if (isSettlementCurrency(currency)) return;
    const timer = setTimeout(() => void refreshQuote(), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [currency, refreshQuote]);

  // Re-evaluate expiry while a quote is on screen.
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), QUOTE_EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, [quote]);

  const currentQuoteState = quoteState({
    currency,
    quote,
    loading: quoteLoading,
    failed: quoteFailed,
    now,
  });
  const canonicalTotalAmount = useMemo(() => {
    const parsed = parseLocaleAmount(totalAmount, locale);
    return parsed.canonicalAmount ?? totalAmount;
  }, [totalAmount, locale]);
  const settlementPreview = settlementAmountFor(canonicalTotalAmount, currency, quote, currentQuoteState);
  /**
   * True when the FX service could not price the chosen currency. The form
   * stays filled in so the user can switch to XLM — an outage at a third
   * party must not discard what they typed.
   */
  const rateUnavailable = currentQuoteState === "unavailable";

  const namedMembers = useMemo(() => members.filter((member) => member.name.trim()), [members]);
  // Preview the split in the settlement asset — what members will actually
  // pay — never in the entered fiat currency.
  const shares = useMemo(() => {
    const amount = Money.tryParse(settlementPreview);
    if (!amount || !amount.isPositive() || namedMembers.length < 2) return [];
    return calculateSplit(amount, namedMembers, paidByMemberId, splitMode);
  }, [settlementPreview, namedMembers, paidByMemberId, splitMode]);
  const payerName = members.find((member) => member.id === paidByMemberId)?.name || "Payer";
  const tags = useMemo(() => parseTagInput(tagsInput), [tagsInput]);
  const setCategory = useCallback((value: string) => {
    setCategoryState(isExpenseCategory(value) ? value : "");
  }, []);

  useEffect(() => {
    if (!members.find((member) => member.id === paidByMemberId)) {
      setPaidByMemberId(members[0]?.id ?? "");
    }
  }, [members, paidByMemberId]);

  const addMember = () => setMembers((previous) => [...previous, blankExpenseMember()]);

  const removeMember = (id: string) => {
    if (members.length <= 2) return;
    setMembers((previous) => previous.filter((member) => member.id !== id));
  };

  const updateMember = (id: string, patch: Partial<Member>) => {
    setMembers((previous) =>
      previous.map((member) => (member.id === id ? { ...member, ...patch } : member))
    );
  };

  const validate = useCallback(() => {
    const nextErrors = validateExpenseFormFields({ title, totalAmount, currency, members, tags, locale });
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }, [title, totalAmount, currency, members, tags, locale]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (saveInFlight.current) return;
      if (!validate()) return;

      saveInFlight.current = true;
      setSubmitting(true);
      try {
        if (beforeCreate && !(await beforeCreate())) return;
        const cleanMembers = members.map((member) => ({
          ...member,
          name: member.name.trim(),
          walletAddress: member.walletAddress ? member.walletAddress.trim().toUpperCase() : undefined,
        }));
        // Use the quote on screen. Only when none has arrived yet (submit
        // beat the debounce) is one fetched, and it is then shown and saved.
        let locked = quote;
        if (!isSettlementCurrency(currency) && (!locked || locked.from !== currency.toUpperCase())) {
          locked = await (inFlightQuote.current ?? refreshQuote());
        }
        const state = quoteState({
          currency,
          quote: locked,
          loading: false,
          failed: locked === null,
        });

        if (!canSubmitWith(state)) {
          // Degraded, expired or disputed quotes block conversion; entering the
          // amount directly in XLM always works. Nothing typed is lost.
          setErrors((previous) => ({ ...previous, quote: QUOTE_STATE_MESSAGES[state] }));
          toastError(`Cannot convert ${currency} right now`, QUOTE_STATE_MESSAGES[state]);
          return;
        }

        const parsedTotal = parseLocaleAmount(totalAmount, locale);
        const canonicalAmount = parsedTotal.canonicalAmount ?? totalAmount;
        const provenance = buildProvenance(canonicalAmount, currency, locked, state);
        if (!provenance) {
          setErrors((previous) => ({ ...previous, totalAmount: "Enter a valid amount." }));
          return;
        }
        const finalSettlementAmount = provenance.settlementAmount;

        const calculatedShares = calculateSplit(
          finalSettlementAmount,
          cleanMembers,
          paidByMemberId,
          splitMode,
        );

        const expense: Expense = {
          id: crypto.randomUUID(),
          title: title.trim(),
          description: description.trim() || undefined,
          totalAmount: finalSettlementAmount,
          currency,
          enteredAmount: provenance.enteredAmount,
          exchangeRate: provenance.exchangeRate,
          exchangeRateTimestamp: provenance.exchangeRateTimestamp,
          exchangeRateSource: provenance.exchangeRateSource,
          settlementAsset: provenance.settlementAsset,
          category: category || null,
          tags,
          splitMode,
          paidByMemberId,
          members: cleanMembers,
          shares: calculatedShares,
          createdAt: new Date().toISOString(),
          settled: false,
        };

        const saveResult = await addExpense(expense);
        if (saveResult?.queued) {
          toastSuccess("Expense draft saved offline", `“${expense.title}” will sync when this wallet is online.`);
        } else {
          trackAnalyticsEvent("expense_created", {
            currency: currency.toUpperCase(),
            split_mode: splitMode,
            member_count: cleanMembers.length,
            has_receipt: false,
          });
          toastSuccess("Expense created!", `"${expense.title}" split among ${cleanMembers.length} members.`);
        }
        onSuccess?.(expense.id);
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "Failed to create expense.";
        if (raw.includes("policy") || raw.includes("permission") || raw.includes("uuid") || raw.includes("syntax")) {
          toastError("Save failed", "Database error. Please check your setup or try again.");
        } else if (raw.includes("fetch") || raw.includes("network") || raw.includes("Network")) {
          toastError("No connection", "Cannot reach server. Check your connection (WARP on?).");
        } else {
          toastError("Error", raw);
        }
      } finally {
        saveInFlight.current = false;
        setSubmitting(false);
      }
    },
    // `currency` and `quote` are both read in the body above and belong
    // here. Omitting `currency` was a live bug, not just a lint gap: the
    // callback closed over "XLM" from the first render, so switching the
    // dropdown to USD or INR and submitting skipped the conversion branch
    // entirely and persisted the typed amount tagged XLM.
    [
      addExpense,
      beforeCreate,
      category,
      currency,
      description,
      members,
      onSuccess,
      paidByMemberId,
      quote,
      refreshQuote,
      splitMode,
      tags,
      title,
      toastError,
      toastSuccess,
      totalAmount,
      validate,
    ],
  );

  return {
    title,
    setTitle,
    description,
    setDescription,
    totalAmount,
    setTotalAmount,
    currency,
    setCurrency,
    category,
    setCategory,
    tagsInput,
    setTagsInput,
    tags,
    splitMode,
    setSplitMode,
    members,
    paidByMemberId,
    setPaidByMemberId,
    submitting,
    errors,
    /** True when the chosen currency cannot be priced; the form is still filled in. */
    rateUnavailable,
    quote,
    quoteState: currentQuoteState,
    refreshQuote,
    /** Converted amount in the settlement asset, or null when not convertible. */
    settlementPreview,
    namedMembers,
    shares,
    payerName,
    addMember,
    removeMember,
    updateMember,
    handleSubmit,
  };
}

function resolveInitialMembers(
  defaultMembers?: Member[],
  currentUserName?: string | null,
  currentUserPublicKey?: string | null,
) {
  if (defaultMembers && defaultMembers.length >= 2) return defaultMembers;

  return [
    {
      id: crypto.randomUUID(),
      name: currentUserName ?? "",
      walletAddress: currentUserPublicKey ?? "",
      weight: 1,
    },
    blankExpenseMember(),
  ];
}
