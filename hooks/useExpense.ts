import { useExpenseContext } from "@/context/ExpenseContext";

export function useExpense() {
  return useExpenseContext();
}
