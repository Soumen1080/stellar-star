/** Reminders and payment requests (#326). */

export type ReminderChannel = "in_app" | "email" | "push";
export type ExternalReminderChannel = Exclude<ReminderChannel, "in_app">;

export type ReminderState = "delivered" | "read" | "dismissed" | "cancelled" | "muted";
export type ReminderTrigger = "manual" | "schedule";

export type ReminderEventKind =
  | "sent"
  | "delivered"
  | "skipped"
  | "read"
  | "dismissed"
  | "cancelled"
  | "muted_trip"
  | "unmuted_trip"
  | "muted_sender"
  | "unmuted_sender"
  | "opted_in"
  | "opted_out"
  | "unsubscribed"
  | "schedule_created"
  | "schedule_disabled";

export interface PaymentReminder {
  /** Also the deep-link id: `/requests/<id>`. Opaque, carries no trip data. */
  id: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  recipientWallet: string;
  senderWallet: string;
  amount: string;
  asset: string;
  note: string | null;
  trigger: ReminderTrigger;
  scheduleId: string | null;
  state: ReminderState;
  /** Channels this reminder actually went out on. */
  channels: ReminderChannel[];
  createdAt: string;
  readAt: string | null;
}

export interface ReminderEvent {
  id: string;
  reminderId: string | null;
  actorWallet: string;
  kind: ReminderEventKind;
  channel: ReminderChannel | null;
  detail: string | null;
  createdAt: string;
}

export interface ReminderPreferences {
  wallet: string;
  emailOptIn: boolean;
  emailAddress: string | null;
  pushOptIn: boolean;
  pushEndpoint: string | null;
  mutedTripIds: string[];
  mutedSenderWallets: string[];
}

export interface ReminderSchedule {
  id: string;
  tripId: string;
  ownerWallet: string;
  intervalDays: number;
  nextRunAt: string;
  active: boolean;
}

/** What the request page shows once the caller has proven they may see it. */
export interface PaymentRequestContext {
  reminder: PaymentReminder;
  viewerRole: "recipient" | "sender";
  tripName: string | null;
  expenseTitle: string | null;
  /** Remaining balance of the requested share right now; null when unknown. */
  outstanding: string | null;
  alreadyPaid: boolean;
  history: ReminderEvent[];
}

/** What a viewer can do with a request: recipient choices, or the sender's cancel. */
export type ReminderAction =
  | "dismiss"
  | "cancel"
  | "mute_trip"
  | "unmute_trip"
  | "mute_sender"
  | "unmute_sender";
