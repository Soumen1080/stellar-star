/**
 * @jest-environment jsdom
 *
 * Unit tests for <QRCodeDisplay /> and <QRToggle />.
 *
 * Dependencies mocked:
 *  - qrcode.react  → QRCodeSVG renders as a plain <svg> to avoid canvas issues
 *  - framer-motion → AnimatePresence / motion.div stubbed for jsdom
 *  - navigator.clipboard → mocked write API to test copy behaviour
 *  - @/components/ui/Toast → useToast mocked so error toasts can be asserted
 *
 * Tests cover:
 *  - Renders QR code SVG
 *  - Displays formatted XLM amount (4 decimal places)
 *  - Displays correct wallet info text
 *  - Copy button text starts as "Copy payment link"
 *  - Clicking Copy writes the correct URI to the clipboard
 *  - Copy button text changes to "Copied!" after clicking
 *  - Clipboard API unavailable → execCommand fallback is used
 *  - Both APIs unavailable → error toast is shown
 *  - QRToggle: panel is hidden by default
 *  - QRToggle: clicking the trigger shows the QR panel
 *  - QRToggle: clicking the trigger again hides the panel
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QRCodeDisplay, QRToggle } from "@/components/payment/QRCodeDisplay";
import type { QRPaymentData } from "@/lib/qr/generator";
import { LocaleProvider } from "@/context/LocaleContext";

function renderQR(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>);
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Stub QRCodeSVG to avoid canvas / SVG rendering issues in jsdom
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="qr-svg" data-value={value} />
  ),
}));

// Stub framer-motion so AnimatePresence renders its children directly
jest.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
  },
}));

// Mock useToast so we can assert on error toasts without a real ToastProvider
const mockToastError = jest.fn();
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ error: mockToastError, success: jest.fn(), info: jest.fn() }),
}));

// ─── Clipboard mock ───────────────────────────────────────────────────────────

let clipboardWritten: string | null = null;

beforeEach(() => {
  clipboardWritten = null;
  Object.defineProperty(navigator, "clipboard", {
    writable: true,
    value: {
      writeText: jest.fn((text: string) => {
        clipboardWritten = text;
        return Promise.resolve();
      }),
    },
  });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─── Test data ────────────────────────────────────────────────────────────────

const testData: QRPaymentData = {
  destination: "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV",
  amount: "25.5",
  memo: "Trip split",
};

// ─── QRCodeDisplay ────────────────────────────────────────────────────────────

describe("QRCodeDisplay — rendering", () => {
  it("renders a QR code SVG element", () => {
    renderQR(<QRCodeDisplay data={testData} />);
    expect(screen.getByTestId("qr-svg")).toBeTruthy();
  });

  it("shows the amount formatted to 4 decimal places", () => {
    const { container } = renderQR(<QRCodeDisplay data={testData} />);
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("XLM 25.5000");
  });

  it("shows 'Scan to pay' label with the formatted amount", () => {
    const { container } = renderQR(<QRCodeDisplay data={testData} />);
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("Scan to pay XLM 25.5000");
  });

  it("shows the compatible wallet note", () => {
    renderQR(<QRCodeDisplay data={testData} />);
    expect(screen.getByText(/freighter.*lobstr.*sep-0007/i)).toBeTruthy();
  });

  it("shows 'Copy payment link' button text by default", () => {
    renderQR(<QRCodeDisplay data={testData} />);
    expect(screen.getByText(/copy payment link/i)).toBeTruthy();
  });

  it("passes the correct SEP-0007 URI value to the QR component", () => {
    renderQR(<QRCodeDisplay data={testData} />);
    const qrSvg = screen.getByTestId("qr-svg");
    const uri = qrSvg.getAttribute("data-value") ?? "";
    expect(uri).toContain("web+stellar:pay");
    expect(uri).toContain(testData.destination);
    expect(uri).toContain(testData.amount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("QRCodeDisplay — copy to clipboard", () => {
  it("copies the payment URI to the clipboard when Copy is clicked", async () => {
    render(<QRCodeDisplay data={testData} />);
    const copyBtn = screen.getByText(/copy payment link/i).closest("button")!;

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(clipboardWritten).not.toBeNull();
    expect(clipboardWritten).toContain("web+stellar:pay");
    expect(clipboardWritten).toContain(testData.destination);
  });

  it("changes button text to 'Copied!' immediately after clicking copy", async () => {
    render(<QRCodeDisplay data={testData} />);
    const copyBtn = screen.getByText(/copy payment link/i).closest("button")!;

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(screen.getByText(/copied!/i)).toBeTruthy();
  });

  it("reverts the button text back to 'Copy payment link' after 2 seconds", async () => {
    render(<QRCodeDisplay data={testData} />);
    const copyBtn = screen.getByText(/copy payment link/i).closest("button")!;

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(screen.getByText(/copied!/i)).toBeTruthy();

    // Advance the fake timer past the 2-second reset
    act(() => {
      jest.advanceTimersByTime(2100);
    });

    expect(screen.getByText(/copy payment link/i)).toBeTruthy();
  });

  it("uses the execCommand fallback when navigator.clipboard is undefined", async () => {
    // Simulate an insecure context where navigator.clipboard is unavailable
    Object.defineProperty(navigator, "clipboard", { writable: true, value: undefined });

    // jsdom doesn't provide execCommand; define a mock that reports success
    const execCommandMock = jest.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      writable: true,
      configurable: true,
      value: execCommandMock,
    });

    render(<QRCodeDisplay data={testData} />);
    const copyBtn = screen.getByText(/copy payment link/i).closest("button")!;

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(execCommandMock).toHaveBeenCalledWith("copy");
    // Copied! feedback should still appear
    expect(screen.getByText(/copied!/i)).toBeTruthy();

    // Restore
    Object.defineProperty(document, "execCommand", { writable: true, configurable: true, value: undefined });
  });

  it("shows an error toast when both clipboard API and execCommand are unavailable", async () => {
    // No Clipboard API
    Object.defineProperty(navigator, "clipboard", { writable: true, value: undefined });
    // execCommand also returns false (failure)
    const execCommandMock = jest.fn().mockReturnValue(false);
    Object.defineProperty(document, "execCommand", {
      writable: true,
      configurable: true,
      value: execCommandMock,
    });

    render(<QRCodeDisplay data={testData} />);
    const copyBtn = screen.getByText(/copy payment link/i).closest("button")!;

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(mockToastError).toHaveBeenCalledWith(
      "Copy unavailable",
      expect.stringContaining("clipboard")
    );
    // Button should NOT show "Copied!" — the copy failed
    expect(screen.queryByText(/copied!/i)).toBeNull();

    // Restore
    Object.defineProperty(document, "execCommand", { writable: true, configurable: true, value: undefined });
  });
});


// ─────────────────────────────────────────────────────────────────────────────

describe("QRCodeDisplay — data edge cases", () => {
  it("renders when there is no memo field", () => {
    const dataNoMemo: QRPaymentData = {
      destination: "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU",
      amount: "10",
    };
    const { container } = renderQR(<QRCodeDisplay data={dataNoMemo} />);
    expect(screen.getByTestId("qr-svg")).toBeTruthy();
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("XLM 10.0000");
  });

  it("URI does not contain memo_type when memo is absent", async () => {
    const dataNoMemo: QRPaymentData = {
      destination: "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU",
      amount: "10",
    };
    renderQR(<QRCodeDisplay data={dataNoMemo} />);
    const qrSvg = screen.getByTestId("qr-svg");
    const uri = qrSvg.getAttribute("data-value") ?? "";
    expect(uri).not.toContain("memo_type");
  });
});

// ─── QRToggle ─────────────────────────────────────────────────────────────────

describe("QRToggle — show / hide behaviour", () => {
  it("does NOT show the QR panel by default", () => {
    render(<QRToggle data={testData} />);
    expect(screen.queryByTestId("qr-svg")).toBeNull();
  });

  it("shows the QR panel after clicking the trigger button", () => {
    render(<QRToggle data={testData} />);
    const trigger = screen.getByRole("button", { name: /qr code/i });
    fireEvent.click(trigger);
    expect(screen.getByTestId("qr-svg")).toBeTruthy();
  });

  it("displays 'QR Code' label when panel is closed", () => {
    render(<QRToggle data={testData} />);
    expect(screen.getByText(/qr code/i)).toBeTruthy();
  });

  it("displays 'Hide QR' label when panel is open", () => {
    render(<QRToggle data={testData} />);
    const trigger = screen.getByRole("button", { name: /qr code/i });
    fireEvent.click(trigger);
    expect(screen.getByText(/hide qr/i)).toBeTruthy();
  });

  it("hides the QR panel again when the trigger is clicked a second time", () => {
    const { container } = render(<QRToggle data={testData} />);
    const triggerBtn = container.querySelector<HTMLButtonElement>("button[title='Show QR code']")!;

    // Open
    fireEvent.click(triggerBtn);
    expect(screen.getByTestId("qr-svg")).toBeTruthy();

    // Close — re-query the trigger by title after state update
    const closeTrigger = container.querySelector<HTMLButtonElement>("button[title='Show QR code']")!;
    fireEvent.click(closeTrigger);
    expect(screen.queryByTestId("qr-svg")).toBeNull();
  });
});
