"use client";

import { Input } from "@/components/ui/Input";
import { ExpenseDescriptionField } from "@/components/expenses/ExpenseDescriptionField";
import { ExpenseFormActions } from "@/components/expenses/ExpenseFormActions";
import { ExpenseMemberList } from "@/components/expenses/ExpenseMemberList";
import { ExpensePayerSelect } from "@/components/expenses/ExpensePayerSelect";
import { ExpenseSplitModeControl } from "@/components/expenses/ExpenseSplitModeControl";
import { ExpenseSplitPreview } from "@/components/expenses/ExpenseSplitPreview";
import { useExpenseForm } from "@/hooks/useExpenseForm";
import type { Member } from "@/types/expense";

interface ExpenseFormProps {
  onSuccess?: (expenseId?: string) => void;
  onCancel?: () => void;
  currentUserPublicKey?: string | null;
  currentUserName?: string | null;
  defaultMembers?: Member[];
}

export function ExpenseForm({
  onSuccess,
  onCancel,
  currentUserPublicKey,
  currentUserName,
  defaultMembers,
}: ExpenseFormProps) {
  const form = useExpenseForm({
    onSuccess,
    currentUserPublicKey,
    currentUserName,
    defaultMembers,
  });

  return (
    <form onSubmit={form.handleSubmit} className="space-y-5">
      <Input
        label="Expense title"
        required
        placeholder="Dinner at Ramen Soul"
        value={form.title}
        onChange={(event) => form.setTitle(event.target.value)}
        error={form.errors.title}
      />

      <ExpenseDescriptionField value={form.description} onChange={form.setDescription} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label="Total amount"
          required
          placeholder="10.5"
          type="number"
          min="0.0000001"
          step="0.0000001"
          value={form.totalAmount}
          onChange={(event) => form.setTotalAmount(event.target.value)}
          error={form.errors.totalAmount}
          trailing={
            <select
              value={form.currency}
              onChange={(e) => form.setCurrency(e.target.value)}
              className="bg-transparent text-xs font-semibold text-[#0F0F14] outline-none cursor-pointer"
            >
              <option value="XLM">XLM</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="INR">INR</option>
            </select>
          }
        />
        <ExpenseSplitModeControl value={form.splitMode} onChange={form.setSplitMode} />
      </div>

      <ExpenseMemberList
        members={form.members}
        splitMode={form.splitMode}
        errors={form.errors}
        onAddMember={form.addMember}
        onRemoveMember={form.removeMember}
        onUpdateMember={form.updateMember}
      />

      <ExpensePayerSelect
        members={form.members}
        value={form.paidByMemberId}
        onChange={form.setPaidByMemberId}
      />

      <ExpenseSplitPreview
        shares={form.shares}
        namedMembers={form.namedMembers}
        payerName={form.payerName}
        totalAmount={form.totalAmount}
      />

      <ExpenseFormActions submitting={form.submitting} onCancel={onCancel} />
    </form>
  );
}
