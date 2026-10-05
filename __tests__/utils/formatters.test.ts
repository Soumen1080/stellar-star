import {
  formatAddress,
  formatXLM,
  cn,
  escapeHtml,
  unescapeHtml,
  sanitizeText,
  sanitizeMetadata,
  sanitizeWalletLabel,
  safeUrl,
} from "@/lib/utils";

// ─── formatAddress ────────────────────────────────────────────────────────────

describe("formatAddress", () => {
  const ADDR = "GBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDR";

  it("truncates a long address with prefix + '...' + suffix", () => {
    const result = formatAddress(ADDR);
    expect(result.startsWith(ADDR.slice(0, 6))).toBe(true);
    expect(result.endsWith(ADDR.slice(-6))).toBe(true);
    expect(result).toContain("...");
  });

  it("returns empty string for empty input", () => {
    expect(formatAddress("")).toBe("");
  });

  it("includes '...' separator between prefix and suffix", () => {
    expect(formatAddress(ADDR)).toContain("...");
  });

  it("respects custom chars parameter", () => {
    const result = formatAddress(ADDR, 4);
    expect(result.startsWith("GBGJ")).toBe(true);
    expect(result).toContain("...");
  });

  it("shows the first N characters correctly", () => {
    const result = formatAddress(ADDR, 8);
    expect(result.startsWith(ADDR.slice(0, 8))).toBe(true);
  });
});

// ─── formatXLM ────────────────────────────────────────────────────────────────

describe("formatXLM", () => {
  it("formats a whole number with at least 2 decimal places", () => {
    const result = formatXLM(100);
    expect(result).toMatch(/100\.\d{2,}/);
  });

  it("accepts string input", () => {
    const result = formatXLM("50.5");
    expect(result).toMatch(/50\./);
  });

  it("formats zero correctly", () => {
    expect(formatXLM(0)).toMatch(/0\./);
  });

  it("formats a small XLM amount (7 decimal precision)", () => {
    // 0.0000001 should be preserved
    const result = formatXLM("0.0000001");
    expect(result).not.toBe("0.00"); // should not be rounded away
  });
});

// ─── cn (class names) ─────────────────────────────────────────────────────────

describe("cn", () => {
  it("merges class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("ignores falsy values", () => {
    expect(cn("foo", false && "bar", undefined, null as unknown as string)).toBe("foo");
  });

  it("handles Tailwind conflicts - last wins", () => {
    // twMerge should resolve p-4 vs p-2 in favour of the last one
    const result = cn("p-4", "p-2");
    expect(result).toBe("p-2");
  });

  it("returns empty string when nothing is passed", () => {
    expect(cn()).toBe("");
  });
});

// ─── escapeHtml & unescapeHtml ───────────────────────────────────────────────

describe("escapeHtml and unescapeHtml", () => {
  it("escapes all dangerous HTML characters", () => {
    const raw = `<script>alert('xss & "more"')</script>`;
    const escaped = escapeHtml(raw);
    expect(escaped).toBe(
      "&lt;script&gt;alert(&#x27;xss &amp; &quot;more&quot;&#x27;)&lt;&#x2F;script&gt;",
    );
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
  });

  it("handles null and undefined gracefully", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("unescapes entities back to original characters", () => {
    const escaped = "&lt;b&gt;Hello &amp; World&lt;&#x2F;b&gt;";
    expect(unescapeHtml(escaped)).toBe("<b>Hello & World</b>");
  });
});

// ─── sanitizeText ────────────────────────────────────────────────────────────

describe("sanitizeText", () => {
  it("strips script tags and inner contents", () => {
    const malicious = `Tokyo Trip <script>evilPayload()</script> 2026`;
    expect(sanitizeText(malicious)).toBe("Tokyo Trip  2026");
  });

  it("strips HTML tags and inline event handlers", () => {
    const malicious = `<img src=x onerror="alert(1)">Important Error`;
    expect(sanitizeText(malicious)).toBe("Important Error");
  });

  it("strips dangerous pseudo-protocols like javascript: and data:", () => {
    expect(sanitizeText("javascript:alert(1)")).toBe("alert(1)");
    expect(sanitizeText("data:text/html;base64,...")).toBe("text/html;base64,...");
  });

  it("leaves clean strings untouched", () => {
    expect(sanitizeText("Tokyo Adventure - 2026")).toBe("Tokyo Adventure - 2026");
  });
});

// ─── sanitizeMetadata ────────────────────────────────────────────────────────

describe("sanitizeMetadata", () => {
  it("strips quotes, tags, and newlines for safe HTML meta tags", () => {
    const raw = `<script>alert(1)</script>Trip "Tokyo"\nNew Line\r\nReturn`;
    const clean = sanitizeMetadata(raw);
    expect(clean).toBe("Trip Tokyo New Line Return");
    expect(clean).not.toContain('"');
    expect(clean).not.toContain("\n");
  });

  it("truncates to maxLength", () => {
    const long = "A".repeat(150);
    const clean = sanitizeMetadata(long, 50);
    expect(clean.length).toBe(50);
  });
});

// ─── sanitizeWalletLabel ─────────────────────────────────────────────────────

describe("sanitizeWalletLabel", () => {
  it("preserves canonical Stellar wallet addresses", () => {
    const addr = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
    expect(sanitizeWalletLabel(addr)).toBe(addr);
  });

  it("strips HTML and special characters from member labels", () => {
    const raw = `Alice <script>alert(1)</script> (VIP)`;
    expect(sanitizeWalletLabel(raw)).toBe("Alice VIP");
  });
});

// ─── safeUrl ─────────────────────────────────────────────────────────────────

describe("safeUrl", () => {
  it("allows safe http, https, and relative URLs", () => {
    expect(safeUrl("https://stellar.org")).toBe("https://stellar.org");
    expect(safeUrl("/trips/tokyo")).toBe("/trips/tokyo");
  });

  it("blocks javascript: and data: URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,test")).toBe("#");
  });
});
