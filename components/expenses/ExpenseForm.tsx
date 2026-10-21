"use client";

import { useState } from "react";
import { ExpenseLabelsFields } from "@/components/expenses/ExpenseLabelsFields";
import { ReceiptCapture } from "@/components/expenses/ReceiptCapture";
import { ReceiptAttachmentStep } from "@/components/expenses/ReceiptAttachmentStep";
import { canUseReceiptDraft, receiptDraftDescription } from "@/lib/receipts/ocr/review";
import { RECEIPT_CURRENCIES } from "@/lib/receipts/ocr/parser";
import { checkReceiptStorage, ReceiptRequestError } from "@/lib/receipts/client";
import { Input } from "@/components/ui/Input";
import { ExpenseDescriptionField } from "@/components/expenses/ExpenseDescriptionField";
import { ExpenseFormActions } from "@/components/expenses/ExpenseFormActions";
import { ExpenseFxPanel } from "@/components/expenses/ExpenseFxPanel";
import { ExpenseMemberList } from "@/components/expenses/ExpenseMemberList";
import { ExpensePayerSelect } from "@/components/expenses/ExpensePayerSelect";
import { ExpenseSplitModeControl } from "@/components/expenses/ExpenseSplitModeControl";
import { ExpenseSplitPreview } from "@/components/expenses/ExpenseSplitPreview";
import { useExpenseForm } from "@/hooks/useExpenseForm";
import type { ExpenseFormInitialValues } from "@/hooks/useExpenseForm";
import type { Member } from "@/types/expense";

interface ExpenseFormProps {
  onSuccess?: (expenseId?: string) => void;
  onCancel?: () => void;
  currentUserPublicKey?: string | null;
  currentUserName?: string | null;
  defaultMembers?: Member[];
  initialValues?: ExpenseFormInitialValues;
}

export function ExpenseForm({
  onSuccess,
  onCancel,
  currentUserPublicKey,
  currentUserName,
  defaultMembers,
  initialValues,
}: ExpenseFormProps) {
  const [capturing, setCapturing] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState("");
  const form = useExpenseForm({
    beforeCreate: async () => {
      if (capturing || createdId) return false;
      setReceiptError("");
      if (receipt) {
        try { await checkReceiptStorage(receipt); }
        catch (error) {
          setReceiptError(error instanceof ReceiptRequestError ? error.message : "Receipt storage is unavailable. Your expense has not been created. Please try again.");
          return false;
        }
      }
      return true;
    },
    onSuccess: (id) => {
      if (receipt && id) setCreatedId(id);
      else onSuccess?.(id);
    },
    currentUserPublicKey,
    currentUserName,
    defaultMembers,
    initialValues,
  });

  if (createdId && receipt) return <ReceiptAttachmentStep expenseId={createdId} file={receipt}
    onDone={() => { setReceipt(null); onSuccess?.(createdId); }} />;

  return (
    <form onSubmit={form.handleSubmit} className="space-y-5">
      {process.env.NEXT_PUBLIC_RECEIPT_OCR_ENABLED !== "false" && <>
        {receiptError && <p role="alert">{receiptError}</p>}
        {capturing ? <ReceiptCapture onCancel={() => setCapturing(false)} onUse={(draft, file) => {
          if (!canUseReceiptDraft(draft)) return;
          form.setTitle(draft.fields.merchant.value.trim());
          form.setTotalAmount(draft.fields.total.value);
          form.setCurrency(draft.fields.currency.value);
          form.setDescription(receiptDraftDescription(draft));
          setReceipt(file);
          setReceiptError("");
          setCapturing(false);
        }} /> : <button type="button" disabled={form.submitting} onClick={() => setCapturing(true)}>
          {receipt ? "Replace receipt draft" : "Capture or select a receipt"}
        </button>}
        {receipt && !capturing && <div className="space-y-2 text-sm">
          <p>Receipt fields reviewed. Creating the expense will attach the unchanged original privately.
            This draft is held only in this screen; closing it discards the photo.</p>
          <button type="button" disabled={form.submitting} onClick={() => setReceipt(null)}>Remove original from draft</button>
        </div>}
      </>}
      <fieldset disabled={capturing || form.submitting} className="space-y-5 border-0 p-0 min-w-0">
      <Input
        label="Expense title"
        required
        placeholder="Dinner at Ramen Soul"
        value={form.title}
        onChange={(event) => form.setTitle(event.target.value)}
        error={form.errors.title}
      />

      <ExpenseDescriptionField value={form.description} onChange={form.setDescription}
        maxLength={receipt || form.description.length > 100 ? 12000 : 100} />

      <ExpenseLabelsFields
        category={form.category}
        onCategoryChange={form.setCategory}
        tagsInput={form.tagsInput}
        onTagsInputChange={form.setTagsInput}
        tags={form.tags}
        error={form.errors.tags}
      />

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
              aria-label="Expense currency"
              value={form.currency}
              onChange={(e) => form.setCurrency(e.target.value)}
              className="pointer-events-auto bg-transparent text-xs font-semibold text-[#0F0F14] outline-none cursor-pointer"
            >
              {RECEIPT_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </select>
          }
        />
        <ExpenseSplitModeControl value={form.splitMode} onChange={form.setSplitMode} />
      </div>

      <ExpenseFxPanel
        enteredAmount={form.totalAmount}
        currency={form.currency}
        quote={form.quote}
        state={form.quoteState}
        settlementAmount={form.settlementPreview}
        error={form.errors.quote}
        onRefresh={() => void form.refreshQuote()}
        onUseSettlementAsset={() => form.setCurrency("XLM")}
      />

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
        totalAmount={form.settlementPreview ?? form.totalAmount}
      />

      <ExpenseFormActions submitting={form.submitting} onCancel={onCancel} />
      </fieldset>
    </form>
  );
}
