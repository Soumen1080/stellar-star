import type { Trip } from "@/types/trip";
import type { Expense } from "@/types/expense";
import {
  canViewBookingDetails,
  createEmptyWorkspace,
  normalizeWorkspace,
  type BookingReference,
  type TravelWorkspace,
} from "@/types/workspace";
import {
  buildPurgeWorkspaceUpdate,
  buildTravelWorkspaceExport,
  detectChainLeakage,
  TRAVEL_WORKSPACE_PRIVACY_POLICY,
} from "@/lib/workspace/privacy";

describe("Travel Workspace Privacy, Chain Isolation, and Data Portability", () => {
  const mockTrip: Trip = {
    id: "trip-paris-2026",
    name: "Paris Summer Trip",
    members: [
      { id: "mem-creator", name: "Alice", walletAddress: "GCREATOR111" },
      { id: "mem-bob", name: "Bob", walletAddress: "GBOB222" },
      { id: "mem-charlie", name: "Charlie", walletAddress: "GCHARLIE333" },
    ],
    expenseIds: ["exp-hotel-1"],
    createdAt: "2026-10-20T10:00:00Z",
    settled: false,
    createdByWallet: "GCREATOR111",
  };

  const mockExpenses: Expense[] = [
    {
      id: "exp-hotel-1",
      title: "Le Marais Apartment",
      totalAmount: "450.0000000",
      currency: "EUR",
      splitMode: "equal",
      paidByMemberId: "mem-creator",
      members: mockTrip.members,
      shares: [],
      createdAt: "2026-10-20T10:00:00Z",
      settled: false,
    },
  ];

  const mockWorkspace: TravelWorkspace = {
    itinerary: [
      {
        id: "itin-1",
        tripId: "trip-paris-2026",
        title: "Check-in at Le Marais",
        startDate: "2026-07-10T14:00:00Z",
        category: "lodging",
        reminderMinutesBefore: 60,
        linkedExpenseIds: ["exp-hotel-1"], // Linked by ID only
        createdAt: "2026-10-20T10:00:00Z",
      },
    ],
    checklists: [
      {
        id: "chk-1",
        tripId: "trip-paris-2026",
        title: "Passports and Eurail Pass",
        category: "documents",
        isCompleted: false,
        assignedToMemberId: "mem-bob",
        createdAt: "2026-10-20T10:00:00Z",
      },
    ],
    bookings: [
      {
        id: "book-pub",
        tripId: "trip-paris-2026",
        title: "Louvre Museum Group Ticket",
        bookingType: "ticket",
        confirmationCode: "LOUVRE-9876",
        referenceUrl: "https://louvre.fr/tickets/9876",
        permission: "all_members",
        createdByWallet: "GCREATOR111",
        linkedExpenseId: "exp-hotel-1",
        createdAt: "2026-10-20T10:00:00Z",
      },
      {
        id: "book-priv",
        tripId: "trip-paris-2026",
        title: "Alice Private Train Booking",
        bookingType: "train",
        confirmationCode: "SNCF-PRIVATE-CONF-SECRET-42",
        referenceUrl: "https://sncf-connect.com/private/pnr?token=secret123",
        permission: "creator_only",
        createdByWallet: "GCREATOR111",
        createdAt: "2026-10-20T10:00:00Z",
      },
      {
        id: "book-restricted",
        tripId: "trip-paris-2026",
        title: "Special Wine Tour",
        bookingType: "other",
        confirmationCode: "WINE-VIP-777",
        permission: "permitted_members",
        permittedMemberIds: ["mem-bob"], // Only Bob is permitted
        createdByWallet: "GBOB222",
        createdAt: "2026-10-20T10:00:00Z",
      },
    ],
  };

  describe("Zero On-Chain Leakage", () => {
    it("detects and flags any private booking codes or URLs if leaked into chain strings", () => {
      const benignChainMemos = [
        "SS:exp:exp-hotel-1",
        "trip-paris-2026:settle:v1",
        "tx_hash_0123456789abcdef",
      ];

      const safeCheck = detectChainLeakage(mockWorkspace, benignChainMemos);
      expect(safeCheck.hasLeak).toBe(false);
      expect(safeCheck.leakedItems).toEqual([]);

      const leakedChainMemos = [
        "SS:exp:exp-hotel-1:SNCF-PRIVATE-CONF-SECRET-42",
      ];
      const leakCheck = detectChainLeakage(mockWorkspace, leakedChainMemos);
      expect(leakCheck.hasLeak).toBe(true);
      expect(leakCheck.leakedItems.length).toBeGreaterThan(0);
      expect(leakCheck.leakedItems[0]).toContain("SNCF-PRIVATE-CONF-SECRET-42");
    });
  });

  describe("Expense Linking without Copying Financial Data", () => {
    it("stores only expense ID references without copying amount or financial fields", () => {
      const item = mockWorkspace.itinerary[0];
      expect(item.linkedExpenseIds).toEqual(["exp-hotel-1"]);

      // Verify that no financial ledger fields exist on the itinerary item
      const rawItem = item as any;
      expect(rawItem.totalAmount).toBeUndefined();
      expect(rawItem.currency).toBeUndefined();
      expect(rawItem.shares).toBeUndefined();
      expect(rawItem.exchangeRate).toBeUndefined();

      // Booking reference links via linkedExpenseId without financial duplication
      const booking = mockWorkspace.bookings[0];
      expect(booking.linkedExpenseId).toBe("exp-hotel-1");
      const rawBooking = booking as any;
      expect(rawBooking.amount).toBeUndefined();
      expect(rawBooking.currency).toBeUndefined();
    });
  });

  describe("Permission-Controlled Booking Access", () => {
    const creatorBooking = mockWorkspace.bookings.find((b) => b.id === "book-priv")!;
    const restrictedBooking = mockWorkspace.bookings.find((b) => b.id === "book-restricted")!;

    it("allows the trip creator to view creator-only bookings", () => {
      const canCreatorView = canViewBookingDetails(
        creatorBooking,
        "GCREATOR111",
        "mem-creator",
        true
      );
      expect(canCreatorView).toBe(true);
    });

    it("denies unauthorized members from viewing creator-only bookings", () => {
      const canBobView = canViewBookingDetails(
        creatorBooking,
        "GBOB222",
        "mem-bob",
        false
      );
      expect(canBobView).toBe(false);
    });

    it("allows designated permitted members to view restricted bookings", () => {
      const canBobView = canViewBookingDetails(
        restrictedBooking,
        "GBOB222",
        "mem-bob",
        false
      );
      expect(canBobView).toBe(true);

      const canCharlieView = canViewBookingDetails(
        restrictedBooking,
        "GCHARLIE333",
        "mem-charlie",
        false
      );
      expect(canCharlieView).toBe(false);
    });
  });

  describe("Travel-only Content Export & Deletion under Privacy Policy", () => {
    it("exports travel-only content as JSON with privacy notice and redacts unauthorized bookings", () => {
      // Export requested by Charlie (not creator, not permitted for private booking or wine tour)
      const exportData = buildTravelWorkspaceExport(
        mockTrip,
        mockWorkspace,
        "GCHARLIE333",
        "mem-charlie",
        false
      );

      expect(exportData.tripId).toBe("trip-paris-2026");
      expect(exportData.privacyNotice).toContain("travel workspace content only");
      expect(exportData.workspace.itinerary.length).toBe(1);
      expect(exportData.workspace.checklists.length).toBe(1);

      // Verify Charlie sees Louvre booking intact
      const louvre = exportData.workspace.bookings.find((b) => b.id === "book-pub")!;
      expect(louvre.confirmationCode).toBe("LOUVRE-9876");

      // Verify private booking is redacted
      const privateBooking = exportData.workspace.bookings.find((b) => b.id === "book-priv")!;
      expect(privateBooking.confirmationCode).toBe("[REDACTED - RESTRICTED ACCESS]");
      expect(privateBooking.referenceUrl).toBeUndefined();
      expect(privateBooking.fileAttachment).toBeNull();
    });

    it("purges travel-only content while leaving trip expenses and ledger intact", () => {
      const purgePayload = buildPurgeWorkspaceUpdate();

      expect(purgePayload.workspace).toBeDefined();
      expect(purgePayload.workspace?.itinerary).toEqual([]);
      expect(purgePayload.workspace?.checklists).toEqual([]);
      expect(purgePayload.workspace?.bookings).toEqual([]);

      // Applying purge to trip:
      const updatedTrip: Trip = {
        ...mockTrip,
        ...purgePayload,
      };

      // Financial ledger remains completely intact
      expect(updatedTrip.expenseIds).toEqual(["exp-hotel-1"]);
      expect(updatedTrip.members.length).toBe(3);
      expect(updatedTrip.settled).toBe(false);
      expect(mockExpenses.length).toBe(1);
    });

    it("exposes clear privacy policy text", () => {
      expect(TRAVEL_WORKSPACE_PRIVACY_POLICY).toContain("Zero On-Chain Leakage");
      expect(TRAVEL_WORKSPACE_PRIVACY_POLICY).toContain("Off-Chain Storage Isolation");
      expect(TRAVEL_WORKSPACE_PRIVACY_POLICY).toContain("Right to Erasure");
    });
  });
});
