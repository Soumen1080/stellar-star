import type {
  HouseholdChore,
  HouseholdChoreCadence,
  HouseholdChorePreference,
} from "@/types/householdChore";

export interface ChoreAssignment {
  walletAddress: string;
  rotationIndex: number;
}

export function nextChoreAssignee(
  chore: Pick<HouseholdChore, "rotationWallets" | "rotationCursor">,
  preferences: HouseholdChorePreference[],
  tripMemberWallets: string[],
): ChoreAssignment | null {
  const optedOut = new Set(
    preferences.filter((preference) => preference.optedOut).map((preference) => preference.walletAddress.toUpperCase()),
  );
  const members = new Set(tripMemberWallets.map((wallet) => wallet.toUpperCase()));
  const roster = chore.rotationWallets;
  if (roster.length === 0) return null;

  for (let offset = 0; offset < roster.length; offset += 1) {
    const rotationIndex = (chore.rotationCursor + offset) % roster.length;
    const walletAddress = roster[rotationIndex];
    if (members.has(walletAddress.toUpperCase()) && !optedOut.has(walletAddress.toUpperCase())) {
      return { walletAddress, rotationIndex };
    }
  }
  return null;
}

export function nextChoreDueDate(
  dueOn: string,
  cadence: HouseholdChoreCadence,
): string {
  const [year, month, day] = dueOn.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (cadence === "weekly") {
    date.setUTCDate(date.getUTCDate() + 7);
  } else if (cadence === "biweekly") {
    date.setUTCDate(date.getUTCDate() + 14);
  } else {
    const targetMonth = date.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    date.setUTCMonth(targetMonth);
  }
  return date.toISOString().slice(0, 10);
}
