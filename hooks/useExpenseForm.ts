"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useExpense } from "@/hooks/useExpense";
import { calculateSplit, isValidStellarAddress, isValidXLMAmount } from "@/lib/split/calculator";
import type { Expense, Member, SplitMode } from "@/types/expense";

export interface UseExpenseFormOptions {
  onSuccess?: (expenseId?: string) => void;
  currentUserPublicKey?: string | null;
  currentUserName?: string | null;
  defaultMembers?: Member[];
}

interface ExpenseFormValidationInput {
  title: string;
  totalAmount: string;
  members: Member[];
}

export function blankExpenseMember(): Member {
  return { id: crypto.randomUUID(), name: "", walletAddress: "", weight: 1 };
}

export function validateExpenseFormFields({
  title,
  totalAmount,
  members,
}: ExpenseFormValidationInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!title.trim()) errors.title = "Title is required.";
  if (!totalAmount || !isValidXLMAmount(totalAmount)) {
    errors.totalAmount = "Enter a valid XLM amount (e.g. 10.5).";
  }

  // Track seen addresses for duplicate detection (case-insensitive).
  const seenAddresses = new Map<string, number>(); // normalised address → first-seen index

  members.forEach((member, index) => {
    if (!member.name.trim()) {
      errors[`member_name_${index}`] = "Name is required.";
    }

    const raw = member.walletAddress?.trim() ?? "";
    if (!raw) {
      errors[`member_addr_${index}`] = "Stellar address is required to enable payments.";
    } else if (!isValidStellarAddress(raw)) {
      errors[`member_addr_${index}`] = "Invalid Stellar address (must start with G, 56 chars).";
    } else {
      // Address is syntactically valid — check for duplicates.
      const normalised = raw.toUpperCase();
      if (seenAddresses.has(normalised)) {
        const firstIdx = seenAddresses.get(normalised)!;
        errors[`member_addr_${index}`] =
          `Duplicate wallet address — already used by member ${firstIdx + 1}.`;
        // Also flag the first member if not already errored.
        if (!errors[`member_addr_${firstIdx}`]) {
          errors[`member_addr_${firstIdx}`] =
            `Duplicate wallet address — also used by member ${index + 1}.`;
        }
      } else {
        seenAddresses.set(normalised, index);
      }
    }
  });

  if (members.filter((member) => member.name.trim()).length < 2) {
    errors.members = "Add at least 2 members.";
  }

  return errors;
}


export function useExpenseForm({
  onSuccess,
  currentUserPublicKey,
  currentUserName,
  defaultMembers,
}: UseExpenseFormOptions) {
  const { addExpense } = useExpense();
  const { success: toastSuccess, error: toastError } = useToast();
  const initialMembersRef = useRef<Member[] | null>(null);

  if (!initialMembersRef.current) {
    initialMembersRef.current = resolveInitialMembers(defaultMembers, currentUserName, currentUserPublicKey);
  }

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [splitMode, setSplitMode] = useState<SplitMode>("equal");
  const [members, setMembers] = useState<Member[]>(initialMembersRef.current!);
  const [paidByMemberId, setPaidByMemberId] = useState(initialMembersRef.current![0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const namedMembers = useMemo(() => members.filter((member) => member.name.trim()), [members]);
  const shares = useMemo(() => {
    const amount = parseFloat(totalAmount);
    if (Number.isNaN(amount) || amount <= 0 || namedMembers.length < 2) return [];
    return calculateSplit(amount, namedMembers, paidByMemberId, splitMode);
  }, [totalAmount, namedMembers, paidByMemberId, splitMode]);
  const payerName = members.find((member) => member.id === paidByMemberId)?.name || "Payer";

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
    const nextErrors = validateExpenseFormFields({ title, totalAmount, members });
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }, [title, totalAmount, members]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!validate()) return;

      setSubmitting(true);
      try {
        const cleanMembers = members.map((member) => ({
          ...member,
          walletAddress: member.walletAddress?.trim(),
        }));
        const calculatedShares = calculateSplit(
          parseFloat(totalAmount),
          cleanMembers,
          paidByMemberId,
          splitMode,
        );
        const expense: Expense = {
          id: crypto.randomUUID(),
          title: title.trim(),
          description: description.trim() || undefined,
          totalAmount: parseFloat(totalAmount).toFixed(7),
          currency: "XLM",
          splitMode,
          paidByMemberId,
          members: cleanMembers,
          shares: calculatedShares,
          createdAt: new Date().toISOString(),
          settled: false,
        };

        await addExpense(expense);
        toastSuccess("Expense created!", `"${expense.title}" split among ${cleanMembers.length} members.`);
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
        setSubmitting(false);
      }
    },
    [
      addExpense,
      description,
      members,
      onSuccess,
      paidByMemberId,
      splitMode,
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
    splitMode,
    setSplitMode,
    members,
    paidByMemberId,
    setPaidByMemberId,
    submitting,
    errors,
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
