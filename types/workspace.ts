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

export type ChoreCadence = "daily" | "weekly" | "monthly";

export interface ChoreCompletion {
  completedAt: string;
  completedByWallet: string;
  assignedMemberId: string;
  periodKey: string;
}

export interface RecurringChore {
  id: string;
  tripId: string;
  title: string;
  cadence: ChoreCadence;
  rotationMemberIds: string[];
  completionHistory: ChoreCompletion[];
  /** Reference only; chore completion never creates or changes an expense. */
  linkedExpenseId?: string | null;
  createdByWallet: string;
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
  chores: RecurringChore[];
  choreOptOutWallets: string[];
  choresEnabled: boolean;
  updatedAt?: string;
}

export function createEmptyWorkspace(): TravelWorkspace {
  return {
    itinerary: [],
    checklists: [],
    bookings: [],
    chores: [],
    choreOptOutWallets: [],
    choresEnabled: true,
    updatedAt: new Date().toISOString(),
  };
}

function isChoreCompletion(value: unknown): value is ChoreCompletion {
  if (!value || typeof value !== "object") return false;
  const completion = value as Record<string, unknown>;
  return typeof completion.completedAt === "string" &&
    typeof completion.completedByWallet === "string" &&
    typeof completion.assignedMemberId === "string" &&
    typeof completion.periodKey === "string";
}

function isRecurringChore(value: unknown): value is RecurringChore {
  if (!value || typeof value !== "object") return false;
  const chore = value as Record<string, unknown>;
  return typeof chore.id === "string" &&
    typeof chore.tripId === "string" &&
    typeof chore.title === "string" &&
    typeof chore.createdByWallet === "string" &&
    typeof chore.createdAt === "string" &&
    ["daily", "weekly", "monthly"].includes(String(chore.cadence)) &&
    Array.isArray(chore.rotationMemberIds) &&
    chore.rotationMemberIds.every((memberId) => typeof memberId === "string") &&
    Array.isArray(chore.completionHistory) &&
    chore.completionHistory.every(isChoreCompletion) &&
    (chore.linkedExpenseId === undefined ||
      chore.linkedExpenseId === null ||
      typeof chore.linkedExpenseId === "string");
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
  const chores = Array.isArray(obj.chores)
    ? obj.chores.filter(isRecurringChore)
    : [];
  const choreOptOutWallets = Array.isArray(obj.choreOptOutWallets)
    ? obj.choreOptOutWallets.filter((wallet): wallet is string => typeof wallet === "string")
    : [];

  return {
    itinerary,
    checklists,
    bookings,
    chores,
    choreOptOutWallets,
    choresEnabled: obj.choresEnabled !== false,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
  };
}

export function chorePeriodKey(cadence: ChoreCadence, date = new Date()): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (cadence === "daily") return day.toISOString().slice(0, 10);
  if (cadence === "monthly") return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() - weekday + 1);
  return day.toISOString().slice(0, 10);
}

export function currentChoreAssignee(
  chore: RecurringChore,
  excludedMemberIds: string[] = [],
): string | null {
  if (chore.rotationMemberIds.length === 0) return null;
  const excluded = new Set(excludedMemberIds);
  for (let offset = 0; offset < chore.rotationMemberIds.length; offset += 1) {
    const index = (chore.completionHistory.length + offset) % chore.rotationMemberIds.length;
    const memberId = chore.rotationMemberIds[index];
    if (!excluded.has(memberId)) return memberId;
  }
  return null;
}

export function choreCompletedThisPeriod(chore: RecurringChore, date = new Date()): boolean {
  const periodKey = chorePeriodKey(chore.cadence, date);
  return chore.completionHistory.some((completion) => completion.periodKey === periodKey);
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
