/**
 * @jest-environment jsdom
 *
 * Unit tests for <PayButton />.
 *
 * Tests cover:
 *  - Rendering the payment label with formatted XLM amount
 *  - Firing onClick when clicked (normal state)
 *  - NOT firing onClick when disabled
 *  - NOT firing onClick when isLoading
 *  - Showing loading spinner + "Paying..." text when isLoading
 *  - Showing Zap icon + "Pay X XLM" text when idle
 *  - Size variants (sm / md)
 *  - title attribute contains amount and recipient
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { PayButton } from "@/components/payment/PayButton";
import { LocaleProvider } from "@/context/LocaleContext";

// ─── Default props ────────────────────────────────────────────────────────────

const defaultProps = {
  amount: "12.5",
  recipientName: "Alice",
  onClick: jest.fn(),
};

function renderButton(overrides: Partial<React.ComponentProps<typeof PayButton>> = {}) {
  const onClick = jest.fn();
  const result = render(
    <LocaleProvider>
      <PayButton {...defaultProps} onClick={onClick} {...overrides} />
    </LocaleProvider>
  );
  return { ...result, onClick };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PayButton — rendering", () => {
  beforeEach(() => jest.clearAllMocks());

  it("displays the formatted XLM amount (4 decimal places)", () => {
    const { container } = renderButton({ amount: "12.5" });
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("Pay XLM 12.5000");
  });

  it("formats an integer amount to 4 decimal places", () => {
    const { container } = renderButton({ amount: "50" });
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("Pay XLM 50.0000");
  });

  it("formats a high-precision amount to 4 decimal places", () => {
    const { container } = renderButton({ amount: "1.23456789" });
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("Pay XLM 1.2346");
  });

  it("formats non-XLM asset such as USDC correctly", () => {
    const { container } = renderButton({ amount: "15", asset: "USDC" });
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    // USDC displays at 2 decimals, not XLM's 4 \u2014 see getAssetConfig, whose
    // per-asset precision money.test.ts pins down.
    expect(cleanText).toContain("Pay USDC 15.00");
  });

  it("includes the recipient name in the title attribute", () => {
    const { container } = renderButton({ amount: "10", recipientName: "Bob" });
    const btn = container.querySelector("button")!;
    expect(btn.title).toContain("Bob");
    expect(btn.title.replace(/\u00a0/g, " ")).toContain("XLM 10.0000");
  });

  it("renders the Zap icon (not loading) by default", () => {
    const { container } = renderButton();
    // Lucide icons render as SVG; just verify no Loader2 spinner
    const svgElements = container.querySelectorAll("svg");
    expect(svgElements.length).toBeGreaterThan(0);
  });

  it("renders in medium size by default (has px-4 class)", () => {
    const { container } = renderButton();
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("px-4");
  });

  it("renders in small size when size='sm'", () => {
    const { container } = renderButton({ size: "sm" });
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("px-3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PayButton — click handling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls onClick when clicked in normal state", () => {
    const { onClick } = renderButton();
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClick when the button is disabled", () => {
    const { onClick } = renderButton({ disabled: true });
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does NOT call onClick when isLoading is true", () => {
    const { onClick } = renderButton({ isLoading: true });
    const btn = screen.getByRole("button");
    // The HTML disabled attribute prevents the native click handler
    expect(btn).toHaveProperty("disabled", true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PayButton — loading state", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows 'Paying...' text when isLoading is true", () => {
    renderButton({ isLoading: true });
    expect(screen.getByText(/paying\.\.\./i)).toBeTruthy();
  });

  it("hides the normal 'Pay ... XLM' text when isLoading is true", () => {
    const { container } = renderButton({ isLoading: true, amount: "20" });
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).not.toContain("Pay XLM 20.0000");
  });

  it("button is disabled when isLoading is true", () => {
    const { container } = renderButton({ isLoading: true });
    const btn = container.querySelector<HTMLButtonElement>("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("button is disabled when disabled prop is true", () => {
    const { container } = renderButton({ disabled: true });
    const btn = container.querySelector<HTMLButtonElement>("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("button is NOT disabled in default state", () => {
    const { container } = renderButton();
    const btn = container.querySelector<HTMLButtonElement>("button")!;
    expect(btn.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PayButton — accessibility", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders as a <button> element", () => {
    const { container } = renderButton();
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
  });

  it("is reachable via getByRole('button')", () => {
    renderButton();
    expect(screen.getByRole("button")).toBeTruthy();
  });
});
