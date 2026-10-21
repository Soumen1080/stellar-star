/** Accept explicit decimal notation only. Never guess separators or sum items. */
export function receiptAmount(raw: string): string | null {
  const value = raw.trim();
  if (!/^\d{1,12}(?:\.\d{1,7})?$/.test(value)) return null;
  return value;
}

export function positiveReceiptAmount(raw: string): boolean {
  const amount = receiptAmount(raw);
  return amount !== null && /[1-9]/.test(amount);
}
