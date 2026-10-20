/**
 * @jest-environment jsdom
 *
 * #328 — the settle tab with a settlement proposal: propose, wait for
 * approval, pay *from* the approved snapshot (reference in UI and memo), and
 * fall back to an uncovered payment once the proposal is revoked.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { SettlementSummary } from "@/components/trips/SettlementSummary";
import { LocaleProvider } from "@/context/LocaleContext";
import { proposalContentHash, proposalMemo, proposalReference, type ProposalResponse, type SettlementProposal } from "@/lib/settlement/proposal";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("@/hooks/useWallet", () => ({ useWallet: jest.fn() }));
jest.mock("@/hooks/useExpense", () => ({ useExpense: jest.fn() }));
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn() }),
}));

const mockPayNet = jest.fn(async () => {});
jest.mock("@/hooks/useNetPayment", () => ({
  useNetPayment: () => ({
    paymentState: { status: "idle" },
    payNetSettlement: mockPayNet,
    payNetPathSettlement: jest.fn(),
    retryOnChainRecord: jest.fn(),
    loadPendingForPayer: jest.fn(),
    hasPendingRetry: false,
    txHash: null,
    onChain: false,
    isIdle: true,
    isLoading: false,
    isSuccess: false,
  }),
}));
jest.mock("@/hooks/usePathPayment", () => ({
  usePathPayment: () => ({
    path: null,
    loading: false,
    failure: null,
    slippageBps: 50,
    setSlippageBps: jest.fn(),
    refreshQuote: jest.fn(),
    clear: jest.fn(),
  }),
}));

// In-memory proposal store standing in for Supabase + RLS.
let stored: SettlementProposal | null = null;
let responses: ProposalResponse[] = [];
jest.mock("@/lib/settlement/proposalQueries", () => ({
  // Fresh arrays per read, like a real query result.
  fetchLatestProposal: async () => (stored ? { proposal: { ...stored }, responses: [...responses] } : null),
  createProposal: async (snapshot: SettlementProposal["snapshot"]) => {
    const { proposalContentHash: contentHash } = jest.requireActual("@/lib/settlement/proposal");
    stored = {
      id: "prop-1",
      tripId: snapshot.tripId,
      creatorWallet: snapshot.creatorWallet,
      contentHash: contentHash(snapshot),
      snapshot,
      status: "open",
      expiresAt: snapshot.expiresAt,
      revokedReason: null,
      createdAt: snapshot.createdAt,
    };
    return stored;
  },
  respondToProposal: async (input: Omit<ProposalResponse, "createdAt"> & { proposalId: string }) => {
    const response = { ...input, createdAt: new Date(Date.now() + responses.length).toISOString() };
    responses.push(response);
    return response;
  },
  setProposalStatus: async (_id: string, status: SettlementProposal["status"], reason: string | null) => {
    if (stored && stored.status === "open") stored = { ...stored, status, revokedReason: reason };
  },
}));

const ASHA = "G".padEnd(56, "A");
const RAVI = "G".padEnd(56, "B");

const trip: Trip = {
  id: "trip-1",
  name: "Goa Weekend",
  members: [
    { id: "member-1", name: "Asha", walletAddress: ASHA },
    { id: "member-2", name: "Ravi", walletAddress: RAVI },
  ],
  expenseIds: ["expense-1"],
  createdAt: "2026-01-01T00:00:00.000Z",
  settled: false,
};

const expenses: Expense[] = [
  {
    id: "expense-1",
    title: "Lunch",
    totalAmount: "5",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-1",
    members: trip.members,
    shares: [
      { memberId: "member-1", name: "Asha", walletAddress: ASHA, amount: "2.5000000", paid: true },
      { memberId: "member-2", name: "Ravi", walletAddress: RAVI, amount: "2.5000000", paid: false },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
    version: 2,
  },
];

function renderSummary() {
  return render(
    <LocaleProvider>
      <SettlementSummary trip={trip} expenses={expenses} />
    </LocaleProvider>,
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

const payButton = () => screen.getByText(/^Pay\b/).closest("button") as HTMLButtonElement;

beforeEach(() => {
  stored = null;
  responses = [];
  mockPayNet.mockClear();
  (useWallet as jest.Mock).mockReturnValue({ publicKey: RAVI, isConnected: true, network: "TESTNET" });
  (useExpense as jest.Mock).mockReturnValue({ expenses, markSharePaid: jest.fn() });
});

it("proposes a frozen settlement and blocks payments until every member approves", async () => {
  renderSummary();
  await click(await screen.findByText("Propose settlement"));

  await screen.findByText("Awaiting approval");
  expect(stored).not.toBeNull();
  expect(stored!.contentHash).toBe(proposalContentHash(stored!.snapshot));
  expect(screen.getByText(proposalReference(stored!.contentHash))).toBeTruthy();
  expect(screen.getByText(/Waiting for every member to approve/)).toBeTruthy();
  expect(payButton().disabled).toBe(true);

  await act(async () => {
    fireEvent.click(payButton());
  });
  expect(mockPayNet).not.toHaveBeenCalled();
});

it("pays from an approved proposal with its snapshot reference in the UI and memo", async () => {
  renderSummary();
  await click(await screen.findByText("Propose settlement"));
  await screen.findByText("Awaiting approval");

  // Asha approved from her device; Ravi approves here.
  responses.push({
    memberId: "member-1",
    wallet: ASHA,
    decision: "approve",
    reason: null,
    contentHash: stored!.contentHash,
    createdAt: new Date(0).toISOString(),
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Approve"));
  });

  await screen.findByText("Approved — payments can begin");
  const memo = proposalMemo(stored!.contentHash);
  expect(screen.getByText(new RegExp(`memo ${memo}`))).toBeTruthy();

  await act(async () => {
    fireEvent.click(payButton());
  });
  expect(mockPayNet).toHaveBeenCalledWith(expect.objectContaining({ memoText: memo, totalAmount: "2.5000000" }));
});

it("does not let a revoked proposal authorize the payment", async () => {
  (useWallet as jest.Mock).mockReturnValue({ publicKey: ASHA, isConnected: true, network: "TESTNET" });
  renderSummary();
  await click(await screen.findByText("Propose settlement"));
  await click(await screen.findByText("Revoke"));
  await screen.findByText("Revoked");

  (useWallet as jest.Mock).mockReturnValue({ publicKey: RAVI, isConnected: true, network: "TESTNET" });
  renderSummary();
  await waitFor(() => expect(screen.getAllByText(/not covered by it/).length).toBeGreaterThan(0));
  const buttons = screen.getAllByText(/^Pay\b/).map((el) => el.closest("button") as HTMLButtonElement);
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]);
  });
  expect(mockPayNet).toHaveBeenCalledWith(expect.objectContaining({ memoText: undefined }));
});

it("requires a reason to reject", async () => {
  renderSummary();
  await click(await screen.findByText("Propose settlement"));
  fireEvent.click(await screen.findByText("Reject"));
  const send = screen.getByText("Send").closest("button") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: "Lunch was 4, not 5" } });
  await act(async () => {
    fireEvent.click(send);
  });
  await screen.findByText("Rejected");
  expect(responses.at(-1)).toMatchObject({ decision: "reject", reason: "Lunch was 4, not 5", wallet: RAVI });
  expect(screen.getByText(/Lunch was 4, not 5/)).toBeTruthy();
});
