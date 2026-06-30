/** @jest-environment jsdom */
/**
 * TripForm duplicate-wallet validation tests.
 *
 * The TripForm validate() function is an internal closure, so we drive it
 * through the rendered form: fill in members with duplicate addresses and
 * click Submit; the error messages should appear in the DOM.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TripForm } from "@/components/trips/TripForm";
import type { TripFormData } from "@/types/trip";

const ADDR_A = "G" + "A".repeat(55); // valid Stellar address
const ADDR_B = "G" + "B".repeat(55);

/** Render TripForm pre-filled with the first member's wallet. */
function renderForm(
  addr1: string,
  onSubmit: (d: TripFormData) => void = jest.fn(),
) {
  return render(
    <TripForm
      onSubmit={onSubmit}
      onCancel={jest.fn()}
      currentUserName="Alice"
      currentUserPublicKey={addr1}
    />,
  );
}

/** Fill the nth wallet address input (0-based). */
function fillWallet(container: HTMLElement, index: number, value: string) {
  const inputs = container.querySelectorAll<HTMLInputElement>(
    "input[placeholder='G... Stellar address *']",
  );
  fireEvent.change(inputs[index], { target: { value } });
}

/** Fill the nth member name input (0-based). */
function fillName(container: HTMLElement, index: number, value: string) {
  const inputs = container.querySelectorAll<HTMLInputElement>(
    "input[placeholder^='Member']",
  );
  fireEvent.change(inputs[index], { target: { value } });
}

/** Click the submit button. */
function submit(container: HTMLElement) {
  const btn = container.querySelector<HTMLButtonElement>("button[type='submit']")!;
  fireEvent.click(btn);
}

/** Returns all elements matching the text pattern (handles multiple flagged members). */
function queryDuplicateErrors() {
  return screen.queryAllByText(/Duplicate wallet address/i);
}

// ---------------------------------------------------------------------------

describe("TripForm — duplicate wallet validation", () => {
  it("blocks submission and shows error when two members share the same address", () => {
    const onSubmit = jest.fn();
    const { container } = renderForm(ADDR_A, onSubmit);

    // Fill trip name (required)
    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='e.g. Bali 2025, Euro Trip']",
    )!;
    fireEvent.change(nameInput, { target: { value: "Summer Trip" } });

    // Fill member 2's name and give it the same address as member 1
    fillName(container, 1, "Bob");
    fillWallet(container, 1, ADDR_A);

    submit(container);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(queryDuplicateErrors().length).toBeGreaterThan(0);
  });

  it("blocks submission for case-insensitive duplicate addresses", () => {
    const onSubmit = jest.fn();
    const { container } = renderForm(ADDR_A, onSubmit);

    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='e.g. Bali 2025, Euro Trip']",
    )!;
    fireEvent.change(nameInput, { target: { value: "Euro Trip" } });

    fillName(container, 1, "Bob");
    // Lowercase version of ADDR_A — should still be detected as duplicate
    fillWallet(container, 1, ADDR_A.toLowerCase());

    submit(container);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(queryDuplicateErrors().length).toBeGreaterThan(0);
  });

  it("allows submission when members have distinct valid addresses", () => {
    const onSubmit = jest.fn();
    const { container } = renderForm(ADDR_A, onSubmit);

    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='e.g. Bali 2025, Euro Trip']",
    )!;
    fireEvent.change(nameInput, { target: { value: "Bali 2025" } });

    fillName(container, 1, "Bob");
    fillWallet(container, 1, ADDR_B);

    submit(container);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(queryDuplicateErrors().length).toBe(0);
  });
});
