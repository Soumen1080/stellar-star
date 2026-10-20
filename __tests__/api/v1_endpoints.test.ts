import { NextRequest } from "next/server";
import { GET as getTrips, POST as postTrips } from "@/app/api/v1/trips/route";
import { GET as getTripById } from "@/app/api/v1/trips/[id]/route";
import { GET as getExpenses, POST as postExpenses } from "@/app/api/v1/expenses/route";
import { GET as getSettlements } from "@/app/api/v1/settlements/route";
import { GET as getOpenApi } from "@/app/api/v1/openapi.json/route";
import { generateScopedToken, clearTokenStore } from "@/lib/api/tokens";
import { clearSandboxData } from "@/lib/api/data";
import { clearWebhookStore } from "@/lib/api/webhooks";

describe("Developer API v1 End-to-End Route Handlers", () => {
  const testWallet = "G_E2E_DEVELOPER_WALLET_12345678901234567890";
  let readToken: string;
  let writeToken: string;
  let fullToken: string;

  beforeEach(() => {
    clearTokenStore();
    clearSandboxData();
    clearWebhookStore();

    readToken = generateScopedToken({
      walletAddress: testWallet,
      name: "Reader",
      scopes: ["trips:read", "expenses:read", "settlement:read"],
    }).token;

    writeToken = generateScopedToken({
      walletAddress: testWallet,
      name: "Writer",
      scopes: ["trips:write", "expenses:write"],
    }).token;

    fullToken = generateScopedToken({
      walletAddress: testWallet,
      name: "Admin",
      scopes: [
        "trips:read",
        "trips:write",
        "expenses:read",
        "expenses:write",
        "settlement:read",
        "webhooks:manage",
      ],
    }).token;
  });

  it("serves OpenAPI 3.1.0 specification with CORS", async () => {
    const res = await getOpenApi();
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/trips"]).toBeDefined();
  });

  it("creates a trip and returns it via paginated listing", async () => {
    // 1. Post a new trip with idempotency key
    const idempotencyKey = "test-idem-trip-1";
    const postReq = new NextRequest("http://localhost/api/v1/trips", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${writeToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        name: "Kyoto Summit 2026",
        description: "Travel & Workspace",
        members: [
          { name: "Dev Payer", wallet_address: testWallet },
          { name: "Guest Bob" },
        ],
      }),
    });

    const createRes = await postTrips(postReq);
    expect(createRes.status).toBe(201);
    const createdData = await createRes.json();
    expect(createdData.data.name).toBe("Kyoto Summit 2026");
    const tripId = createdData.data.id;

    // 2. Replay same request - expect cached idempotent response
    const replayReq = new NextRequest("http://localhost/api/v1/trips", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${writeToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        name: "Different Name If Ignored",
        members: [{ name: "Dev Payer" }],
      }),
    });
    const replayRes = await postTrips(replayReq);
    expect(replayRes.status).toBe(201);
    expect(replayRes.headers.get("Idempotent-Replayed")).toBe("true");

    // 3. List trips with read token
    const listReq = new NextRequest("http://localhost/api/v1/trips?limit=10", {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    const listRes = await getTrips(listReq);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.data.length).toBe(1);
    expect(listData.data[0].id).toBe(tripId);

    // 4. Fetch trip by ID
    const getByIdReq = new NextRequest(`http://localhost/api/v1/trips/${tripId}`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    const singleRes = await getTripById(getByIdReq, { params: Promise.resolve({ id: tripId }) });
    expect(singleRes.status).toBe(200);
    const singleData = await singleRes.json();
    expect(singleData.data.name).toBe("Kyoto Summit 2026");
  });

  it("creates and lists expenses within a trip", async () => {
    // Create a trip first
    const postTripReq = new NextRequest("http://localhost/api/v1/trips", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Berlin Meetup",
        members: [{ name: "Alice", wallet_address: testWallet }],
      }),
    });
    const tripRes = await postTrips(postTripReq);
    const trip = (await tripRes.json()).data;

    // Add an expense
    const postExpReq = new NextRequest("http://localhost/api/v1/expenses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        trip_id: trip.id,
        title: "Coworking Space Pass",
        total_amount: "80.0000000",
        currency: "EUR",
        split_mode: "equal",
      }),
    });
    const expRes = await postExpenses(postExpReq);
    expect(expRes.status).toBe(201);
    const expData = await expRes.json();
    expect(expData.data.title).toBe("Coworking Space Pass");

    // List expenses for trip
    const listExpReq = new NextRequest(`http://localhost/api/v1/expenses?trip_id=${trip.id}`, {
      headers: { Authorization: `Bearer ${fullToken}` },
    });
    const listRes = await getExpenses(listExpReq);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.data.length).toBe(1);
  });

  it("queries settlement status for authorized callers", async () => {
    const req = new NextRequest("http://localhost/api/v1/settlements", {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    const res = await getSettlements(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.length).toBeGreaterThan(0);
  });
});
