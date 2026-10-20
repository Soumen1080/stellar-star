import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatMoney } from "@/lib/money/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatAddress(address: unknown, chars = 6): string {
  if (!address || typeof address !== "string") return "";
  const trimmed = address.trim();
  if (!trimmed) return "";
  if (trimmed.length <= chars * 2) return trimmed;
  return `${trimmed.slice(0, chars)}...${trimmed.slice(-chars)}`;
}

/**
 * Stably formats a wallet address or member label for SSR and client rendering.
 * Prevents hydration mismatch by ensuring deterministic output regardless of
 * server environment or initial client state.
 */
export function formatWalletLabel(
  walletAddress?: unknown,
  customLabel?: unknown,
  chars = 6
): string {
  if (customLabel && typeof customLabel === "string" && customLabel.trim()) {
    return sanitizeWalletLabel(customLabel, 60);
  }
  if (walletAddress && typeof walletAddress === "string" && walletAddress.trim()) {
    return formatAddress(walletAddress, chars);
  }
  return "";
}

/**
 * Formats an XLM amount for display using a stable locale (en-US by default).
 *
 * Delegates to {@link formatMoney} so that rounding mode, decimal precision,
 * and grouping separators are all governed by a single source of truth.
 * Callers that need dynamic locale-awareness should use `formatMoney` or `useLocale`.
 */
export function formatXLM(amount: string | number, locale: string = "en-US"): string {
  return formatMoney(amount, "XLM", locale).formatted;
}

const PRESET_DATE_OPTIONS: Record<string, Intl.DateTimeFormatOptions> = {
  short: { month: "numeric", day: "numeric", year: "numeric" },
  medium: { month: "short", day: "numeric", year: "numeric" },
  long: { month: "long", day: "numeric", year: "numeric" },
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
};

/**
 * Stably formats dates using UTC timezone and default en-US locale.
 * This guarantees deterministic server-side rendering and initial client hydration
 * without mismatch warnings.
 */
export function formatDateStable(
  dateInput: Date | string | number,
  options?: Intl.DateTimeFormatOptions | "short" | "medium" | "long" | "full"
): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return "—";

  const base =
    typeof options === "string"
      ? PRESET_DATE_OPTIONS[options] ?? PRESET_DATE_OPTIONS.medium
      : options ?? PRESET_DATE_OPTIONS.medium;

  const resolved: Intl.DateTimeFormatOptions = {
    ...base,
    timeZone: base.timeZone ?? "UTC",
  };

  try {
    return new Intl.DateTimeFormat("en-US", resolved).format(date);
  } catch {
    return date.toISOString().split("T")[0];
  }
}

/**
 * Stably formats date and time frozen to UTC to prevent SSR hydration mismatches.
 */
export function formatDateTimeStable(dateInput: Date | string | number): string {
  return formatDateStable(dateInput, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * Freezes a timestamp to a stable formatted UTC string safe for SSR hydration.
 */
export function formatStableTimestamp(timestamp: Date | string | number): string {
  return formatDateTimeStable(timestamp);
}

/**
 * Escapes HTML characters in dynamic text to prevent cross-site scripting (XSS).
 */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  const s = String(str);
  const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
    "`": "&#x60;",
  };
  return s.replace(/[&<>"'/`]/g, (match) => htmlEscapes[match]);
}

/**
 * Reverses HTML entity escaping for plain text display.
 */
export function unescapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  const s = String(str);
  const htmlUnescapes: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
    "&#x2F;": "/",
    "&#47;": "/",
    "&#x60;": "`",
    "&#96;": "`",
  };
  return s.replace(
    /&(?:amp|lt|gt|quot|#x27|#39|#x2F|#47|#x60|#96);/g,
    (match) => htmlUnescapes[match] || match,
  );
}

/**
 * Strips script tags, HTML elements, event handlers, and dangerous URL protocols
 * from user-supplied strings before rendering in UI components.
 */
export function sanitizeText(str: unknown): string {
  if (str === null || str === undefined) return "";
  let s = String(str);
  // Strip script tags and their contents
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  // Strip HTML tags
  s = s.replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "");
  // Strip dangerous pseudo-protocols
  s = s.replace(/(?:javascript|data|vbscript):/gi, "");
  // Strip inline event handler attributes like onload=, onerror=
  s = s.replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Strip non-printable ASCII control characters except newline and tab
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return s.trim();
}

/**
 * Sanitizes dynamic values (such as trip names or route parameters) for safe use
 * in server-rendered metadata (page titles, meta descriptions, OpenGraph tags).
 * Removes newlines, quotes, HTML tags, and truncates to maxLength.
 */
export function sanitizeMetadata(str: unknown, maxLength = 100): string {
  if (str === null || str === undefined) return "";
  let s = sanitizeText(str);
  // Remove newlines, tabs, and quotes that can break HTML meta attributes
  s = s.replace(/[\r\n\t]/g, " ").replace(/["'<>]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLength) {
    s = s.slice(0, maxLength).trim();
  }
  return s;
}

/**
 * Sanitizes wallet addresses or member names before inclusion in page metadata or toast text.
 */
export function sanitizeWalletLabel(label: unknown, maxLength = 60): string {
  if (label === null || label === undefined) return "";
  let s = sanitizeMetadata(label, maxLength);
  // Keep only safe identifier characters (alphanumeric, spaces, periods, dashes, underscores)
  s = s.replace(/[^\w\s.-]/g, "").trim();
  return s;
}

/**
 * Validates and sanitizes a URL, allowing only safe protocols (http, https, mailto, stellar, relative).
 */
export function safeUrl(url: unknown, fallback = "#"): string {
  if (typeof url !== "string" || !url.trim()) return fallback;
  const trimmed = url.trim();
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) {
    return fallback;
  }
  if (/^(?:https?:\/\/|mailto:|stellar:|\/)/i.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

/**
 * Copies `text` to the system clipboard.
 *
 * Strategy (most-to-least capable):
 *  1. `navigator.clipboard.writeText` — requires a secure context (HTTPS /
 *     localhost). Available in all modern browsers on secure origins.
 *  2. `document.execCommand("copy")` via a temporary textarea — legacy
 *     fallback that works on plain HTTP and inside many in-app WebViews
 *     (Freighter, Lobstr, Telegram, etc.) where the Clipboard API is absent.
 *
 * @returns `true` when the text was copied, `false` when both strategies fail.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // ── Modern Clipboard API ───────────────────────────────────────────────────
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy approach (e.g. permission denied).
    }
  }

  // ── Legacy execCommand fallback ────────────────────────────────────────────
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Keep the textarea off-screen so it doesn't affect layout or scroll.
    textarea.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand("copy");
    document.body.removeChild(textarea);
    return success;
  } catch {
    return false;
  }
}
