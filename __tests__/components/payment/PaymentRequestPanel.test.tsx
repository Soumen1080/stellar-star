/**
 * @jest-environment jsdom
 *
 * <PaymentRequestPanel /> (#327): human-readable preview, time-bounded tx QR
 * when the payer's account is readable, pay-URI fallback otherwise, copyable
 * URIs, and an expired state that cannot be copied or scanned usefully.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaymentRequestPanel, type PaymentRequestInput } from "@/components/payment/PaymentRequestPanel";

jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr-svg" data-value={value} />,
}));
jest.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: { div: ({ children, ...rest }: any) => <div {...rest}>{children}</div> },
}));
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ error: jest.fn(), success: jest.fn(), info: jest.fn() }),
}));
jest.mock("@/lib/stellar/fees", () => ({ getSuggestedBaseFee: async () => "100" }));

const CREDITOR = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const DEBTOR = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";

const input: PaymentRequestInput = {
  kind: "share",
  destination: CREDITOR,
  source: DEBTOR,
  asset: "native",
  amount: "7.5000000",
  tripId: "trip-1",
  items: [{ expenseId: "exp-1", memberId: "bob", amount: "7.5000000" }],
};

let clipboard: string | null;
let horizonOk: boolean;

beforeEach(() => {
  clipboard = null;
  horizonOk = true;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn(async (text: string) => void (clipboard = text)) },
  });
  global.fetch = jest.fn(async () => ({
    ok: horizonOk,
    json: async () => ({ sequence: "100" }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

const qrValue = () => screen.getByTestId("qr-svg").getAttribute("data-value") ?? "";

it("shows a human-readable preview of every field before anything is signed", () => {
  render(<PaymentRequestPanel input={input} />);
  const preview = screen.getByLabelText("Payment request preview");
  expect(preview.textContent).toContain(CREDITOR);
  expect(preview.textContent).toContain("7.5000000 XLM");
  expect(preview.textContent).toContain("Testnet");
  expect(preview.textContent).toMatch(/SSR:[0-9A-F]{12}/);
  expect(preview.textContent).toContain("Expires");
});

it("uses a time-bounded tx QR when the payer's account is readable", async () => {
  render(<PaymentRequestPanel input={input} />);
  await waitFor(() => expect(qrValue().startsWith("web+stellar:tx?")).toBe(true));
  expect(screen.getByText(/refused by the network after expiry/i)).toBeTruthy();
});

it("falls back to a pay QR when the account cannot be read", async () => {
  horizonOk = false;
  render(<PaymentRequestPanel input={input} />);
  await act(async () => {});
  expect(qrValue().startsWith("web+stellar:pay?")).toBe(true);
});

it("copies the fallback pay URI and the app link", async () => {
  render(<PaymentRequestPanel input={input} />);
  await act(async () => {
    fireEvent.click(screen.getByText(/copy wallet uri/i));
  });
  expect(clipboard).toMatch(/^web\+stellar:pay\?.*destination=GDQA/);
  expect(clipboard).toContain("network_passphrase=");

  await act(async () => {
    fireEvent.click(screen.getByText(/copy app link/i));
  });
  expect(clipboard).toMatch(/\/pay\?r=/);
});

it("marks an expired request and disables copying it", async () => {
  jest.useFakeTimers();
  render(<PaymentRequestPanel input={input} />);
  fireEvent.change(screen.getByLabelText(/expires after/i), { target: { value: String(60 * 60) } });
  act(() => {
    jest.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    jest.advanceTimersByTime(15_000);
  });
  expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
  expect((screen.getByText(/copy wallet uri/i).closest("button") as HTMLButtonElement).disabled).toBe(true);
});

it("explains, rather than renders, a request it cannot build", () => {
  render(<PaymentRequestPanel input={{ ...input, destination: "not-an-address" }} />);
  expect(screen.getByRole("alert").textContent).toMatch(/no valid Stellar address/);
  expect(screen.queryByTestId("qr-svg")).toBeNull();
});
