/**
 * Keyset cursors (#449): opaque round-trip, strict validation, and no
 * duplicated or skipped rows when rows are inserted while a reader pages.
 */

import {
  compareKeysetDesc,
  decodeCursor,
  encodeCursor,
  isAfterCursor,
  keysetOrFilter,
  toKeysetPage,
} from "@/lib/pagination/keyset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("keyset cursors", () => {
  it("round-trips an opaque cursor, keeping microseconds verbatim", () => {
    const createdAt = "2026-10-05T10:00:00.123456+00:00";
    const cursor = encodeCursor(createdAt, id(7));
    expect(cursor.startsWith("v1.")).toBe(true);
    expect(cursor).not.toContain(createdAt);
    expect(decodeCursor(cursor)).toEqual({ createdAt, id: id(7) });
  });

  it("rejects tampered or malicious cursors", () => {
    for (const bad of ["v1.%%%", "v1." + Buffer.from('{"c":"x","i":"y"}').toString("base64"), "2026-01-01T00:00:00Z|1,id.gt.0", "x".repeat(300)]) {
      expect(() => decodeCursor(bad)).toThrow(/Invalid cursor/);
    }
  });

  it("builds a quoted tuple predicate", () => {
    expect(keysetOrFilter({ createdAt: "2026-01-01T00:00:00Z", id: id(1) })).toBe(
      `created_at.lt."2026-01-01T00:00:00Z",and(created_at.eq."2026-01-01T00:00:00Z",id.lt.${id(1)})`,
    );
  });

  it("concurrent inserts and shared timestamps never duplicate or skip rows", () => {
    // 50 rows, many sharing a timestamp so a timestamp-only cursor would skip.
    let table = Array.from({ length: 50 }, (_, n) => ({
      id: id(n + 1),
      createdAt: `2026-10-01T00:00:${String(Math.floor(n / 5)).padStart(2, "0")}.000000Z`,
    }));
    const readPage = (cursor: string | null, limit: number) => {
      const decoded = decodeCursor(cursor);
      const rows = [...table].sort(compareKeysetDesc).filter((r) => !decoded || isAfterCursor(r, decoded));
      return toKeysetPage(rows.slice(0, limit + 1), limit, (r) => r);
    };

    const seen: string[] = [];
    let cursor: string | null = null;
    let insertedId = 1000;
    do {
      const page = readPage(cursor, 7);
      seen.push(...page.data.map((r) => r.id));
      // A writer inserts newer rows between every page read.
      table = [...table, { id: id(insertedId++), createdAt: "2026-12-01T00:00:00.000000Z" }];
      cursor = page.pagination.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });
});
