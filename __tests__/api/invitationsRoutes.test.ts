import { NextRequest } from "next/server";
import { GET as verifyRoute } from "@/app/api/invitations/verify/route";
import { POST as claimRoute } from "@/app/api/invitations/claim/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import * as claimLib from "@/lib/invitations/claim";

const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

describe("Invitation API Routes (/api/invitations/verify & /api/invitations/claim)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("GET /api/invitations/verify", () => {
    it("returns 400 Bad Request when token parameter is missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/invitations/verify");
      const res = await verifyRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("token parameter is required");
    });

    it("returns 403 Forbidden when tripId does not match the invitation token", async () => {
      jest.spyOn(claimLib, "verifyTripInvite").mockRejectedValue(
        new Error("TRIP_MISMATCH: Invitation token does not belong to the specified trip."),
      );

      const req = new NextRequest("http://localhost:3000/api/invitations/verify?token=xyz123&tripId=wrong-trip");
      const res = await verifyRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("TRIP_MISMATCH");
    });

    it("returns 410 Gone when invite has expired or revoked", async () => {
      jest.spyOn(claimLib, "verifyTripInvite").mockRejectedValue(
        new Error("This invitation has expired."),
      );

      const req = new NextRequest("http://localhost:3000/api/invitations/verify?token=expired-token");
      const res = await verifyRoute(req);
      expect(res.status).toBe(410);
      const data = await res.json();
      expect(data.error).toContain("expired");
    });

    it("returns 200 OK with summary and no-store cache when valid", async () => {
      const mockSummary: claimLib.TripInviteSummary = {
        inviteId: "inv-1",
        tripId: "trip-tokyo-2026",
        tripName: "Tokyo 2026",
        inviterWallet: WALLET,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        unclaimedMembers: [{ id: "m-bob", name: "Bob" }],
        isExpired: false,
        isRevoked: false,
        isExhausted: false,
      };

      jest.spyOn(claimLib, "verifyTripInvite").mockResolvedValue(mockSummary);

      const req = new NextRequest("http://localhost:3000/api/invitations/verify?token=valid-tokyo-token&tripId=trip-tokyo-2026");
      const res = await verifyRoute(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.json();
      expect(data.tripId).toBe("trip-tokyo-2026");
    });
  });

  describe("POST /api/invitations/claim", () => {
    it("returns 401 Unauthorized when Authorization header is absent", async () => {
      const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        body: JSON.stringify({ token: "tokyo-token", selectedMemberId: "m-bob" }),
      });
      const res = await claimRoute(req);
      expect(res.status).toBe(401);
    });

    it("returns 400 Bad Request when token is missing in body", async () => {
      const sessionToken = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ selectedMemberId: "m-bob" }),
      });
      const res = await claimRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invitation token is required");
    });

    it("returns 403 Forbidden when token trip does not match body tripId", async () => {
      jest.spyOn(claimLib, "claimTripInvite").mockRejectedValue(
        new Error("TRIP_MISMATCH: Invitation token does not belong to the specified trip."),
      );

      const sessionToken = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: "tokyo-token",
          tripId: "trip-paris-secret",
          selectedMemberId: "m-secret-2",
        }),
      });
      const res = await claimRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("TRIP_MISMATCH");
    });

    it("returns 409 Conflict when claiming wallet is already a member", async () => {
      jest.spyOn(claimLib, "claimTripInvite").mockRejectedValue(
        new Error("WALLET_ALREADY_MEMBER: This wallet is already a member of this trip."),
      );

      const sessionToken = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: "tokyo-token",
          selectedMemberId: "m-charlie",
        }),
      });
      const res = await claimRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("WALLET_ALREADY_MEMBER");
    });

    it("returns 409 Conflict when slot is already claimed by another wallet", async () => {
      jest.spyOn(claimLib, "claimTripInvite").mockRejectedValue(
        new Error("SLOT_ALREADY_CLAIMED: This member slot has already been claimed by another wallet."),
      );

      const sessionToken = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: "tokyo-token",
          selectedMemberId: "m-bob",
        }),
      });
      const res = await claimRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("SLOT_ALREADY_CLAIMED");
    });

    it("returns 200 OK on successful claim", async () => {
      jest.spyOn(claimLib, "claimTripInvite").mockResolvedValue({
        success: true,
        tripId: "trip-tokyo-2026",
        tripName: "Tokyo 2026",
        memberId: "m-bob",
        memberName: "Bob",
      });

      const sessionToken = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: "tokyo-token",
          tripId: "trip-tokyo-2026",
          selectedMemberId: "m-bob",
        }),
      });
      const res = await claimRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.memberId).toBe("m-bob");
    });
  });
});
