/**
 * Travel Workspace Privacy and Data Protection
 *
 * Guarantees:
 * 1. Zero On-Chain Leakage: Private booking confirmation codes, tickets, URLs,
 *    and personal travel itineraries are strictly kept off-chain and NEVER written
 *    to Stellar transaction memos, Soroban contract state, or Horizon records.
 * 2. Privacy Policy Compliance: Members can export their travel workspace content
 *    (in standard JSON) or purge/delete travel-only content without altering
 *    the trip's financial ledger, balances, or settlement history.
 * 3. Permission Control: Sensitive booking links and files can be restricted to
 *    designated members or the creator, preventing leakage even within shared trips.
 */

import type { Trip } from "@/types/trip";
import {
  canViewBookingDetails,
  createEmptyWorkspace,
  normalizeWorkspace,
  type BookingReference,
  type TravelWorkspace,
} from "@/types/workspace";

export const TRAVEL_WORKSPACE_PRIVACY_POLICY = `Stellar Star Travel Workspace Privacy Policy:

1. Zero On-Chain Leakage & Off-Chain Storage Isolation:
All travel workspace content (dated itinerary items, collaborative checklists, packing lists, recurring chores and their completion history, booking references, and file attachments) is stored solely in private workspace storage (Postgres with RLS and browser storage). It is NEVER submitted to the Stellar blockchain, Soroban smart contracts, Horizon transaction memos, or public attestations. Chore completion is coordination metadata, not a payment, and cannot change balances.

2. Permission-Controlled Booking Data:
Booking confirmation numbers, tickets, private URLs, and notes can be permissioned to "all members", "trip creator only", or "specific permitted members". Unauthorized trip members cannot view or export restricted booking details.

3. Right to Data Portability (Export):
Any trip member may export travel-only workspace content at any time in portable JSON format without copying financial ledger records or exposing on-chain keys.

4. Right to Erasure (Delete):
Trip members may purge or delete travel-only content at any time. Deleting travel content leaves all financial settlement records, expense entries, member shares, and on-chain proofs fully intact.`;

export interface TravelExportPayload {
  version: "1.0";
  exportedAt: string;
  tripId: string;
  tripName: string;
  privacyNotice: string;
  workspace: {
    itinerary: TravelWorkspace["itinerary"];
    checklists: TravelWorkspace["checklists"];
    bookings: BookingReference[];
    chores: TravelWorkspace["chores"];
    choreOptOutWallets: TravelWorkspace["choreOptOutWallets"];
    choresEnabled: boolean;
  };
}

/**
 * Builds a portable JSON export containing ONLY travel workspace content,
 * respecting permission controls and redacting restricted booking details.
 */
export function buildTravelWorkspaceExport(
  trip: Trip,
  workspace: TravelWorkspace,
  currentUserWallet?: string | null,
  currentMemberId?: string | null,
  isTripCreator?: boolean
): TravelExportPayload {
  const normalized = normalizeWorkspace(workspace);

  // Redact restricted booking references if the current user lacks permission
  const safeBookings: BookingReference[] = normalized.bookings.map((b) => {
    const hasAccess = canViewBookingDetails(
      b,
      currentUserWallet,
      currentMemberId,
      isTripCreator
    );

    if (hasAccess) {
      return { ...b };
    }

    return {
      ...b,
      confirmationCode: "[REDACTED - RESTRICTED ACCESS]",
      referenceUrl: undefined,
      fileAttachment: null,
      notes: "[Restricted to authorized members]",
    };
  });

  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    tripId: trip.id,
    tripName: trip.name,
    privacyNotice:
      "This export contains travel workspace content only. No financial ledger, secret keys, or on-chain settlement details are included.",
    workspace: {
      itinerary: normalized.itinerary,
      checklists: normalized.checklists,
      bookings: safeBookings,
      chores: normalized.chores,
      choreOptOutWallets: normalized.choreOptOutWallets,
      choresEnabled: normalized.choresEnabled,
    },
  };
}

/**
 * Checks whether any private booking confirmation codes or private URLs
 * have leaked into on-chain data (such as transaction memos or contract arguments).
 */
export function detectChainLeakage(
  workspace: TravelWorkspace,
  onChainStrings: string[]
): { hasLeak: boolean; leakedItems: string[] } {
  const leaks: string[] = [];

  for (const booking of workspace.bookings) {
    if (booking.confirmationCode && booking.confirmationCode.length >= 4) {
      const code = booking.confirmationCode.toLowerCase();
      for (const str of onChainStrings) {
        if (str.toLowerCase().includes(code)) {
          leaks.push(`Booking confirmation code '${booking.confirmationCode}' leaked on-chain`);
        }
      }
    }

    if (booking.referenceUrl && booking.referenceUrl.length >= 8) {
      const url = booking.referenceUrl.toLowerCase();
      for (const str of onChainStrings) {
        if (str.toLowerCase().includes(url)) {
          leaks.push(`Booking reference URL '${booking.referenceUrl}' leaked on-chain`);
        }
      }
    }
  }

  return {
    hasLeak: leaks.length > 0,
    leakedItems: leaks,
  };
}

/**
 * Prepares the payload to delete travel-only workspace content
 * without affecting expenses, member shares, or ledger settlements.
 */
export function buildPurgeWorkspaceUpdate(): Partial<Trip> {
  return {
    workspace: createEmptyWorkspace(),
  };
}
