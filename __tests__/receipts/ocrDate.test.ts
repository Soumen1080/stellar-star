import { receiptDate } from "@/lib/receipts/ocr/date";

test.each(["2024-02-29", "2026-10-20"])("accepts exact ISO receipt date %s", (date) => {
  expect(receiptDate(date)).toBe(date);
});
test.each(["2026-02-29", "2026-04-31", "2026-13-01", "03/04/2026", "04-03-2026", "2026-1-1", "", "2026-01-01T00:00:00Z"])(
  "requires manual correction for %s", (date) => expect(receiptDate(date)).toBeNull());
