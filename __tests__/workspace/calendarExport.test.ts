import type { Trip } from "@/types/trip";
import type { ItineraryItem } from "@/types/workspace";
import {
  buildTripCalendarIcs,
  escapeIcsText,
  formatIcsDate,
  getGoogleCalendarUrl,
} from "@/lib/workspace/calendarExport";

describe("Calendar Export (RFC 5545 iCalendar)", () => {
  const mockTrip: Trip = {
    id: "trip-japan-2026",
    name: "Tokyo & Kyoto Explorer, 2026; Team Trip",
    members: [{ id: "m-1", name: "Alice" }],
    expenseIds: [],
    createdAt: "2026-10-20T10:00:00Z",
    settled: false,
  };

  const mockItinerary: ItineraryItem[] = [
    {
      id: "item-flight-1",
      tripId: "trip-japan-2026",
      title: "Flight from SFO to NRT, Flight #NH007",
      description: "Flight reservation; seat 12A\\nCarry-on bag included.",
      location: "San Francisco International Airport (SFO)",
      startDate: "2026-11-05T11:30:00Z",
      endDate: "2026-11-06T15:00:00Z",
      category: "flight",
      reminderMinutesBefore: 120, // 2 hour reminder
      linkedExpenseIds: ["exp-flight-123"],
      createdAt: "2026-10-20T10:00:00Z",
    },
    {
      id: "item-shibuya-sky",
      tripId: "trip-japan-2026",
      title: "Shibuya Sky Observation Deck",
      location: "Shibuya Scramble Square",
      startDate: "2026-11-07T18:00:00Z",
      category: "activity",
      reminderMinutesBefore: null,
      createdAt: "2026-10-20T10:00:00Z",
    },
    {
      id: "item-all-day-fuji",
      tripId: "trip-japan-2026",
      title: "Mount Fuji Day Trip",
      startDate: "2026-11-08", // All-day date
      endDate: "2026-11-08",
      category: "activity",
      createdAt: "2026-10-20T10:00:00Z",
    },
  ];

  it("escapes special characters per RFC 5545 section 3.3.11", () => {
    const raw = "Special chars: backslash \\ and semicolon ; and comma , and newline\nSecond line.";
    const escaped = escapeIcsText(raw);
    expect(escaped).toBe(
      "Special chars: backslash \\\\ and semicolon \\; and comma \\, and newline\\nSecond line."
    );
  });

  it("formats all-day dates and datetime strings properly", () => {
    const allDay = formatIcsDate("2026-11-08", "UTC");
    expect(allDay.isAllDay).toBe(true);
    expect(allDay.formatted).toBe("20261108");

    const utcTime = formatIcsDate("2026-11-05T11:30:00Z", "UTC");
    expect(utcTime.isAllDay).toBe(false);
    expect(utcTime.formatted).toBe("20261105T113000Z");
  });

  it("generates a valid RFC 5545 iCalendar stream with correct headers", () => {
    const ics = buildTripCalendarIcs(mockTrip, mockItinerary, { timezone: "Asia/Tokyo" });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//Stellar Star//Travel Workspace//EN");
    expect(ics).toContain("CALSCALE:GREGORIAN");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("X-WR-TIMEZONE:Asia/Tokyo");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("respects the member's timezone in DTSTART and DTEND", () => {
    const icsTokyo = buildTripCalendarIcs(mockTrip, mockItinerary, { timezone: "Asia/Tokyo" });
    expect(icsTokyo).toContain("X-WR-TIMEZONE:Asia/Tokyo");
    expect(icsTokyo).toContain("BEGIN:VEVENT");
    expect(icsTokyo).toContain("SUMMARY:Flight from SFO to NRT\\, Flight #NH007");

    const icsUtc = buildTripCalendarIcs(mockTrip, mockItinerary, { timezone: "UTC" });
    expect(icsUtc).toContain("X-WR-TIMEZONE:UTC");
    expect(icsUtc).toContain("DTSTART:20261105T113000Z");
  });

  it("includes VALARM block when optional reminders are specified", () => {
    const ics = buildTripCalendarIcs(mockTrip, mockItinerary, { timezone: "UTC" });

    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("ACTION:DISPLAY");
    expect(ics).toContain("TRIGGER:-PT120M"); // 120 minutes before
    expect(ics).toContain("DESCRIPTION:Reminder: Flight from SFO to NRT\\, Flight #NH007");
    expect(ics).toContain("END:VALARM");
  });

  it("omits VALARM when reminder is null or zero", () => {
    const shibuyaOnly = mockItinerary.filter((i) => i.id === "item-shibuya-sky");
    const ics = buildTripCalendarIcs(mockTrip, shibuyaOnly, { timezone: "UTC" });

    expect(ics).not.toContain("BEGIN:VALARM");
  });

  it("generates 1-click Google Calendar URL with correct parameters", () => {
    const item = mockItinerary[0];
    const url = getGoogleCalendarUrl(item, "Asia/Tokyo");

    expect(url).toContain("calendar.google.com/calendar/render");
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("text=Flight+from+SFO+to+NRT%2C+Flight+%23NH007");
    expect(url).toContain("location=San+Francisco+International+Airport+%28SFO%29");
    expect(url).toContain("ctz=Asia%2FTokyo");
  });
});
