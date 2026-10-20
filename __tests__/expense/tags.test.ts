import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_EXPENSE,
  normalizeTag,
  normalizeTags,
  parseTagInput,
  validateTags,
} from "@/lib/expense/tags";
import { categoryLabel, normalizeCategory } from "@/lib/expense/categories";

describe("normalizeTag", () => {
  it.each([
    ["Beach", "beach"],
    ["#Beach Day", "beach-day"],
    ["  BEACH_DAY  ", "beach-day"],
    ["day 2!!", "day-2"],
    ["--trailing--", "trailing"],
    ["café", "café"],
    ["###", ""],
    ["   ", ""],
  ])("normalizes %p to %p", (raw, expected) => {
    expect(normalizeTag(raw)).toBe(expected);
  });

  it("caps length without leaving a dangling hyphen", () => {
    const long = `${"a".repeat(MAX_TAG_LENGTH - 1)} bcd`;
    const tag = normalizeTag(long);
    expect(tag.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    expect(tag.endsWith("-")).toBe(false);
  });
});

describe("normalizeTags / parseTagInput", () => {
  it("de-duplicates spellings of the same tag, keeping first-seen order", () => {
    expect(normalizeTags(["Beach", "food", "#beach", "BEACH"])).toEqual(["beach", "food"]);
  });

  it("drops empties and tolerates null", () => {
    expect(normalizeTags(["", "  ", "#"])).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it("splits comma-separated input", () => {
    expect(parseTagInput("beach, Day 2,, #food")).toEqual(["beach", "day-2", "food"]);
  });

  it("limits the number of tags per expense", () => {
    const tags = Array.from({ length: MAX_TAGS_PER_EXPENSE + 1 }, (_, i) => `t${i}`);
    expect(validateTags(tags)).toMatch(/at most/);
    expect(validateTags(tags.slice(0, MAX_TAGS_PER_EXPENSE))).toBeNull();
  });
});

describe("normalizeCategory", () => {
  it("accepts known categories case-insensitively and treats blank as none", () => {
    expect(normalizeCategory(" Food ")).toBe("food");
    expect(normalizeCategory("")).toBeNull();
    expect(normalizeCategory(undefined)).toBeNull();
  });

  it("rejects unknown categories instead of silently dropping them", () => {
    expect(() => normalizeCategory("meals")).toThrow(/Unknown category/);
    expect(() => normalizeCategory(42)).toThrow();
  });

  it("labels uncategorized expenses", () => {
    expect(categoryLabel(null)).toBe("Uncategorized");
    expect(categoryLabel("lodging")).toBe("Lodging");
  });
});
