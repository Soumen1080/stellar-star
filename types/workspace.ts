/**
 * Travel Workspace Types
 *
 * Lightweight shared workspace for trips:
 * - Dated itinerary items with optional reminders
 * - Collaborative packing lists and checklists
 * - Permission-controlled booking references and files
 * - Zero on-chain leak: private booking and itinerary details are strictly kept off-chain
 */

export type ItineraryCategory =
  | "flight"
  | "lodging"
  | "activity"
  | "transit"
  | "food"
  | "meeting"
  | "other";

export interface ItineraryItem {
  id: string;
  tripId: string;
  title: string;
  description?: string;
  location?: string;
  /** ISO 8601 string or YYYY-MM-DDTHH:mm */
  startDate: string;
  /** ISO 8601 string or YYYY-MM-DDTHH:mm */
  endDate?: string;
  category: ItineraryCategory;
  /** Optional reminder in minutes prior to startDate (e.g. 15, 30, 60, 1440) */
  reminderMinutesBefore?: number | null;
  /** References to existing expenses on the trip WITHOUT duplicating financial data */
  linkedExpenseIds?: string[];
  /** Optional link to a booking reference */
  bookingReferenceId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export type ChecklistCategory = "packing" | "todo" | "documents" | "general";

export interface ChecklistItem {
  id: string;
  tripId: string;
  title: string;
  category: ChecklistCategory;
  isCompleted: boolean;
  /** Member ID assigned to this item */
  assignedToMemberId?: string | null;
  /** Wallet address of member who created or added this item */
  addedByWallet?: string;
  dueDate?: string | null;
  createdAt: string;
}

export type BookingType = "flight" | "hotel" | "rental" | "train" | "ticket" | "other";

export type BookingPermission = "all_members" | "creator_only" | "permitted_members";

export interface BookingAttachment {
  name: string;
  size: number;
  type: string;
  dataUrl?: string;
}

export interface BookingReference {
  id: string;
  tripId: string;
  title: string;
  bookingType: BookingType;
  /** Private confirmation code (e.g. airline PNR, reservation #) */
  confirmationCode?: string;
  /** Private booking URL or management portal link */
  referenceUrl?: string;
  /** Attached document or pass */
  fileAttachment?: BookingAttachment | null;
  notes?: string;
  /** Access control for private booking details */
  permission: BookingPermission;
  /** Specific member IDs allowed to view if permission is 'permitted_members' */
  permittedMemberIds?: string[];
  createdByWallet: string;
  /** Linked expense ID without copying financial data */
  linkedExpenseId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface TravelWorkspace {
  itinerary: ItineraryItem[];
  checklists: ChecklistItem[];
  bookings: BookingReference[];
  updatedAt?: string;
}

export function createEmptyWorkspace(): TravelWorkspace {
  return {
    itinerary: [],
    checklists: [],
    bookings: [],
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeWorkspace(raw: unknown): TravelWorkspace {
  if (!raw || typeof raw !== "object") {
    return createEmptyWorkspace();
  }

  const obj = raw as Record<string, unknown>;
  const itinerary = Array.isArray(obj.itinerary)
    ? (obj.itinerary as ItineraryItem[]).filter(
        (item) => item && typeof item === "object" && typeof item.title === "string"
      )
    : [];

  const checklists = Array.isArray(obj.checklists)
    ? (obj.checklists as ChecklistItem[]).filter(
        (item) => item && typeof item === "object" && typeof item.title === "string"
      )
    : [];

  const bookings = Array.isArray(obj.bookings)
    ? (obj.bookings as BookingReference[]).filter(
        (item) => item && typeof item === "object" && typeof item.title === "string"
      )
    : [];

  return {
    itinerary,
    checklists,
    bookings,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
  };
}

/**
 * Checks if a member has permission to see sensitive booking details
 * (confirmation code, private link, attachment).
 */
export function canViewBookingDetails(
  booking: BookingReference,
  currentUserWallet?: string | null,
  currentMemberId?: string | null,
  isTripCreator?: boolean
): boolean {
  if (isTripCreator) return true;
  if (currentUserWallet && booking.createdByWallet.toLowerCase() === currentUserWallet.toLowerCase()) {
    return true;
  }
  if (booking.permission === "all_members") return true;
  if (booking.permission === "creator_only") return false;
  if (booking.permission === "permitted_members") {
    if (!currentMemberId) return false;
    return (booking.permittedMemberIds ?? []).includes(currentMemberId);
  }
  return false;
}
