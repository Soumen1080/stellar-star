/**
 * RFC 5545 iCalendar (.ics) Export for Travel Workspace
 *
 * Generates standards-compliant iCalendar data respecting each member's timezone,
 * with support for dated events, time ranges, locations, descriptions, categories,
 * and optional reminders (VALARM).
 */

import type { Trip } from "@/types/trip";
import type { ItineraryItem } from "@/types/workspace";

export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
];

export function getSystemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === "string" && tz.trim()) {
      return tz.trim();
    }
  } catch {
    // Fallback if browser environment does not support Intl
  }
  return "UTC";
}

/**
 * Escapes characters per RFC 5545 section 3.3.11 for TEXT values:
 * backslash (\), semicolon (;), comma (,), and newline.
 */
export function escapeIcsText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Formats a date string into standard iCalendar format.
 * If time is present, returns { formatted: 'YYYYMMDDTHHMMSS', isAllDay: false }.
 * If only date is present (YYYY-MM-DD), returns { formatted: 'YYYYMMDD', isAllDay: true }.
 */
export function formatIcsDate(
  dateInput: string,
  timezone: string
): { formatted: string; isAllDay: boolean } {
  const trimmed = dateInput.trim();

  // Pure date YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const clean = trimmed.replace(/-/g, "");
    return { formatted: clean, isAllDay: true };
  }

  // Parse ISO or local datetime
  const dateObj = new Date(trimmed);
  if (isNaN(dateObj.getTime())) {
    // Fallback if unparseable
    const now = new Date();
    return {
      formatted:
        now.getUTCFullYear() +
        String(now.getUTCMonth() + 1).padStart(2, "0") +
        String(now.getUTCDate()).padStart(2, "0") +
        "T" +
        String(now.getUTCHours()).padStart(2, "0") +
        String(now.getUTCMinutes()).padStart(2, "0") +
        "00",
      isAllDay: false,
    };
  }

  // If timezone is UTC or end with Z
  if (timezone === "UTC" || trimmed.endsWith("Z")) {
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getUTCDate()).padStart(2, "0");
    const h = String(dateObj.getUTCHours()).padStart(2, "0");
    const min = String(dateObj.getUTCMinutes()).padStart(2, "0");
    const s = String(dateObj.getUTCSeconds()).padStart(2, "0");
    return { formatted: `${y}${m}${d}T${h}${min}${s}Z`, isAllDay: false };
  }

  // Format in the member's target timezone using Intl
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(dateObj);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";

    const y = getPart("year");
    const m = getPart("month");
    const d = getPart("day");
    let h = getPart("hour");
    if (h === "24") h = "00";
    const min = getPart("minute");
    const s = getPart("second");

    return { formatted: `${y}${m}${d}T${h}${min}${s}`, isAllDay: false };
  } catch {
    // Fallback to UTC
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getUTCDate()).padStart(2, "0");
    const h = String(dateObj.getUTCHours()).padStart(2, "0");
    const min = String(dateObj.getUTCMinutes()).padStart(2, "0");
    const s = String(dateObj.getUTCSeconds()).padStart(2, "0");
    return { formatted: `${y}${m}${d}T${h}${min}${s}Z`, isAllDay: false };
  }
}

/**
 * Builds RFC 5545 iCalendar text for a trip's itinerary.
 */
export function buildTripCalendarIcs(
  trip: Trip,
  itinerary: ItineraryItem[],
  options: { timezone?: string; memberName?: string } = {}
): string {
  const timezone = options.timezone || getSystemTimezone();
  const now = new Date();
  const dtStamp =
    now.getUTCFullYear() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    "T" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0") +
    "Z";

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Stellar Star//Travel Workspace//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(trip.name || "Trip Itinerary")}`,
    `X-WR-TIMEZONE:${timezone}`,
  ];

  for (const item of itinerary) {
    const start = formatIcsDate(item.startDate, timezone);
    const end = item.endDate ? formatIcsDate(item.endDate, timezone) : null;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${item.id || Math.random().toString(36).slice(2)}@stellarstar.app`);
    lines.push(`DTSTAMP:${dtStamp}`);

    if (start.isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${start.formatted}`);
      if (end?.isAllDay) {
        lines.push(`DTEND;VALUE=DATE:${end.formatted}`);
      }
    } else if (timezone === "UTC" || start.formatted.endsWith("Z")) {
      lines.push(`DTSTART:${start.formatted}`);
      if (end) {
        lines.push(`DTEND:${end.formatted}`);
      }
    } else {
      lines.push(`DTSTART;TZID=${timezone}:${start.formatted}`);
      if (end) {
        lines.push(`DTEND;TZID=${timezone}:${end.formatted}`);
      }
    }

    lines.push(`SUMMARY:${escapeIcsText(item.title)}`);

    let description = item.description || "";
    if (item.category) {
      description = `[Category: ${item.category.toUpperCase()}] ${description}`;
    }
    if (item.linkedExpenseIds && item.linkedExpenseIds.length > 0) {
      description += `\\n(Linked to ${item.linkedExpenseIds.length} trip expense(s))`;
    }
    if (description.trim()) {
      lines.push(`DESCRIPTION:${escapeIcsText(description.trim())}`);
    }

    if (item.location) {
      lines.push(`LOCATION:${escapeIcsText(item.location)}`);
    }

    lines.push("STATUS:CONFIRMED");

    // Optional reminders (RFC 5545 VALARM)
    if (
      typeof item.reminderMinutesBefore === "number" &&
      item.reminderMinutesBefore > 0
    ) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:Reminder: ${escapeIcsText(item.title)}`);
      lines.push(`TRIGGER:-PT${Math.floor(item.reminderMinutesBefore)}M`);
      lines.push("END:VALARM");
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // Join lines with RFC 5545 standard CRLF (\r\n)
  return lines.join("\r\n");
}

/**
 * Creates a direct 1-click Google Calendar URL for an itinerary item.
 */
export function getGoogleCalendarUrl(
  item: ItineraryItem,
  timezone: string = "UTC"
): string {
  const start = formatIcsDate(item.startDate, timezone).formatted.replace(/[-:]/g, "");
  const end = item.endDate
    ? formatIcsDate(item.endDate, timezone).formatted.replace(/[-:]/g, "")
    : start;

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: item.title,
    dates: `${start}/${end}`,
    details: item.description || "",
    location: item.location || "",
    ctz: timezone,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
