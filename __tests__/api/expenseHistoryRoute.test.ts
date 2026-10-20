import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/expenses/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import { searchExpenseHistory } from "@/lib/supabase/queries";

jest.mock("@/lib/supabase/queries", () => {
  const actual = jest.requireActual("@/lib/supabase/queries");
  return {
    ...actual,
    searchExpenseHistory: jest.fn(),
    insertExpense: jest.fn(async (expense: unknown) => expense),
  };
});

const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const mockedSearch = searchExpenseHistory as jest.MockedFunction<typeof searchExpenseHistory>;

function authed(url: string, init: { method?: string; body?: string } = {}) {
  return new NextRequest(url, {
    ...init,
    headers: { Authorization: `Bearer ${signWalletSession(WALLET)}` },
  });
}

describe("GET /api/expenses — searchable history", () => {
  beforeEach(() => {
    mockedSearch.mockReset();
    mockedSearch.mockResolvedValue({ data: [], pagination: { limit: 20, nextCursor: null, hasMore: false } });
  });

  it.each([
    ["status=weird", /Invalid status/],
    ["category=meals", /Unknown category/],
    ["from=2026-02-30", /YYYY-MM-DD/],
    ["from=2026-10-10&to=2026-10-01", /on or before/],
    ["tripId=not-a-uuid", /tripId/],
    ["tzOffset=100000", /tzOffset/],
    ["cursor=2026-10-01T00:00:00Z%7Cnope", /ISO 8601/],
  ])("rejects %s with 400", async (query, message) => {
    const res = await GET(authed(`http://localhost:3000/api/expenses?${query}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("passes parsed filters, trip scope, cursor and timezone to the server-side search", async () => {
    const cursor = encodeURIComponent(`2026-10-01T00:00:00.123456+00:00|${TRIP_ID}`);
    const res = await GET(
      authed(
        `http://localhost:3000/api/expenses?q=Beach&category=lodging&tags=Goa&status=partial` +
          `&asset=XLM&from=2026-10-01&to=2026-10-31&tripId=${TRIP_ID}&tzOffset=-330&limit=5&cursor=${cursor}`,
      ),
    );

    expect(res.status).toBe(200);
    expect(mockedSearch).toHaveBeenCalledTimes(1);
    const [query] = mockedSearch.mock.calls[0];
    expect(query).toEqual({
      limit: 5,
      tripId: TRIP_ID,
      tzOffsetMinutes: -330,
      cursor: { createdAt: "2026-10-01T00:00:00.123456+00:00", id: TRIP_ID },
      filters: {
        q: "Beach",
        category: "lodging",
        tags: ["goa"],
        payer: null,
        status: "partial",
        asset: "native",
        from: "2026-10-01",
        to: "2026-10-31",
      },
    });
  });
});

describe("POST /api/expenses — categories and tags", () => {
  const base = {
    title: "Dinner",
    totalAmount: "10",
    paidByMemberId: "m1",
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob" },
    ],
  };

  it("rejects an unknown category", async () => {
    const res = await POST(
      authed("http://localhost:3000/api/expenses", {
        method: "POST",
        body: JSON.stringify({ ...base, category: "meals" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown category/);
  });

  it("rejects too many tags", async () => {
    const res = await POST(
      authed("http://localhost:3000/api/expenses", {
        method: "POST",
        body: JSON.stringify({ ...base, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most/);
  });

  it("stores the normalized category and tags", async () => {
    const res = await POST(
      authed("http://localhost:3000/api/expenses", {
        method: "POST",
        body: JSON.stringify({ ...base, category: "Food", tags: ["#Dinner", "dinner", "Day 2"] }),
      }),
    );
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.category).toBe("food");
    expect(saved.tags).toEqual(["dinner", "day-2"]);
  });
});
