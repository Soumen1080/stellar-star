/**
 * RFC 4180 CSV encoding for exports (#324).
 *
 * Two properties matter more than prettiness:
 *
 *  1. **Amounts are written exactly as stored.** They are decimal strings in
 *     this codebase and are never passed through `Number`, so "0.0000001"
 *     cannot become "1e-7" and "12345678901.1234567" cannot lose digits.
 *  2. **Free text cannot become a formula.** A trip name such as
 *     `=HYPERLINK(...)` would execute when the file is opened in a spreadsheet,
 *     so text cells starting with = + - @ (or a tab/CR) are prefixed with an
 *     apostrophe. Amount cells are validated as plain decimals instead, so a
 *     negative balance keeps its minus sign.
 */

export type CsvCell =
  | { kind: "text"; value: string | null | undefined }
  | { kind: "amount"; value: string | null | undefined }
  | { kind: "raw"; value: string | number | boolean | null | undefined };

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

export const text = (value: string | null | undefined): CsvCell => ({ kind: "text", value });
export const amount = (value: string | null | undefined): CsvCell => ({ kind: "amount", value });
export const raw = (value: string | number | boolean | null | undefined): CsvCell => ({ kind: "raw", value });

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function encodeCell(cell: CsvCell): string {
  if (cell.value === null || cell.value === undefined) return "";
  switch (cell.kind) {
    case "amount": {
      const value = String(cell.value).trim();
      if (!PLAIN_DECIMAL.test(value)) {
        // Never silently "fix" an amount: an unexpected shape is a bug upstream.
        throw new TypeError(`Refusing to export a non-decimal amount: "${value}"`);
      }
      return value;
    }
    case "text": {
      const value = String(cell.value);
      return quote(FORMULA_PREFIX.test(value) ? `'${value}` : value);
    }
    case "raw":
      if (typeof cell.value === "number" && !Number.isSafeInteger(cell.value)) {
        throw new TypeError("Only safe integers may be exported as raw numbers; use amount() for money.");
      }
      return quote(String(cell.value));
  }
}

/** Encodes a header and rows. CRLF line endings, as RFC 4180 specifies. */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header.map((h) => quote(h)).join(",")];
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new RangeError(`CSV row has ${row.length} cells, expected ${header.length}.`);
    }
    lines.push(row.map(encodeCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
