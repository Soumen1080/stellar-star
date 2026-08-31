/**
 * @jest-environment jsdom
 *
 * Unit tests for <TripForm />.
 *
 * TripForm is a self-contained form (no external context needed) so we can
 * render it directly and drive it via fireEvent.
 *
 * Tests cover:
 *  - Rendering of all fields and buttons
 *  - Input handling (typing updates displayed values)
 *  - Validation: missing trip name, fewer than 2 named members,
 *    missing/invalid/duplicate wallet addresses
 *  - Successful submit fires onSubmit with trimmed, filtered data
 *  - Cancel button fires onCancel without calling onSubmit
 *  - Add member / remove member interactions
 *  - Pre-fill from currentUserName / currentUserPublicKey props
 *  - initialData population
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TripForm } from "@/components/trips/TripForm";
import type { TripFormData } from "@/types/trip";

// ─── Valid Stellar addresses ──────────────────────────────────────────────────
const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderForm(props: Partial<React.ComponentProps<typeof TripForm>> = {}) {
  const onSubmit = jest.fn();
  const onCancel = jest.fn();
  const result = render(
    <TripForm onSubmit={onSubmit} onCancel={onCancel} {...props} />
  );
  return { ...result, onSubmit, onCancel };
}

/** Get the trip-name input by its placeholder */
function tripNameInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(
    "input[placeholder='e.g. Bali 2025, Euro Trip']"
  )!;
}

/** Get all member-name inputs by placeholder prefix "Member" */
function memberNameInputs(container: HTMLElement): NodeListOf<HTMLInputElement> {
  return container.querySelectorAll<HTMLInputElement>("input[placeholder^='Member']");
}

/** Get all wallet-address inputs */
function walletInputs(container: HTMLElement): NodeListOf<HTMLInputElement> {
  return container.querySelectorAll<HTMLInputElement>(
    "input[placeholder^='G... Stellar address']"
  );
}

function clickSubmit(container: HTMLElement) {
  const form = container.querySelector<HTMLFormElement>("form")!;
  fireEvent.submit(form);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

describe("TripForm — rendering", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders the Trip name input", () => {
    const { container } = renderForm();
    expect(tripNameInput(container)).not.toBeNull();
  });

  it("renders a Description input", () => {
    const { container } = renderForm();
    const desc = container.querySelector<HTMLInputElement>(
      "input[placeholder='Add a short note about this trip']"
    );
    expect(desc).not.toBeNull();
  });

  it("renders at least 2 member name inputs by default", () => {
    const { container } = renderForm();
    expect(memberNameInputs(container).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a Cancel button", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  it("renders a Create Trip submit button", () => {
    const { container } = renderForm();
    const btn = container.querySelector<HTMLButtonElement>("button[type='submit']");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toMatch(/create trip/i);
  });
});

// ─── Input handling ───────────────────────────────────────────────────────────

describe("TripForm — input handling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates the trip name when the user types", () => {
    const { container } = renderForm();
    const input = tripNameInput(container);
    fireEvent.change(input, { target: { value: "Bali 2025" } });
    expect(input.value).toBe("Bali 2025");
  });

  it("updates member 1 name when the user types", () => {
    const { container } = renderForm();
    const inputs = memberNameInputs(container);
    fireEvent.change(inputs[0], { target: { value: "Alice" } });
    expect(inputs[0].value).toBe("Alice");
  });

  it("updates member 1 wallet address when the user types", () => {
    const { container } = renderForm();
    const wallets = walletInputs(container);
    fireEvent.change(wallets[0], { target: { value: ADDR_A } });
    expect(wallets[0].value).toBe(ADDR_A);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("TripForm — validation errors", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows error when trip name is empty", () => {
    const { container, onSubmit } = renderForm();
    clickSubmit(container);
    expect(screen.getByText(/trip name is required/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows error when fewer than 2 members are named", () => {
    const { container, onSubmit } = renderForm();
    fireEvent.change(tripNameInput(container), { target: { value: "My Trip" } });
    // Leave both member names blank (default state has empty names)
    clickSubmit(container);
    expect(screen.getByText(/at least 2 members/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows a named member without a wallet address (placeholder member)", () => {
    const { container, onSubmit } = renderForm();
    const names = memberNameInputs(container);
    const wallets = walletInputs(container);

    fireEvent.change(tripNameInput(container), { target: { value: "Summer Trip" } });
    fireEvent.change(names[0], { target: { value: "Alice" } });
    // Leave wallet[0] empty
    fireEvent.change(names[1], { target: { value: "Bob" } });
    fireEvent.change(wallets[1], { target: { value: ADDR_B } });

    clickSubmit(container);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data: TripFormData = onSubmit.mock.calls[0][0];
    expect(data.members[0].name).toBe("Alice");
    expect(data.members[0].walletAddress).toBeUndefined();
    expect(data.members[1].name).toBe("Bob");
    expect(data.members[1].walletAddress).toBe(ADDR_B);
  });

  it("shows an error when a wallet address has an invalid format", () => {
    const { container, onSubmit } = renderForm();
    const names = memberNameInputs(container);
    const wallets = walletInputs(container);

    fireEvent.change(tripNameInput(container), { target: { value: "Euro Trip" } });
    fireEvent.change(names[0], { target: { value: "Alice" } });
    fireEvent.change(wallets[0], { target: { value: "INVALID_ADDRESS" } });
    fireEvent.change(names[1], { target: { value: "Bob" } });
    fireEvent.change(wallets[1], { target: { value: ADDR_B } });

    clickSubmit(container);

    expect(screen.getByText(/invalid stellar address/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a duplicate-wallet error when two members share the same address", () => {
    const { container, onSubmit } = renderForm({
      currentUserName: "Alice",
      currentUserPublicKey: ADDR_A,
    });
    const names = memberNameInputs(container);
    const wallets = walletInputs(container);

    fireEvent.change(tripNameInput(container), { target: { value: "Shared Addr Trip" } });
    fireEvent.change(names[1], { target: { value: "Bob" } });
    // Give Bob the same address as Alice
    fireEvent.change(wallets[1], { target: { value: ADDR_A } });

    clickSubmit(container);

    expect(screen.queryAllByText(/duplicate wallet address/i).length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ─── Successful submit ────────────────────────────────────────────────────────

describe("TripForm — successful submit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls onSubmit with trimmed name, description and correct members", () => {
    const { container, onSubmit } = renderForm();
    const names = memberNameInputs(container);
    const wallets = walletInputs(container);

    fireEvent.change(tripNameInput(container), { target: { value: "  Bali 2025  " } });
    fireEvent.change(
      container.querySelector<HTMLInputElement>(
        "input[placeholder='Add a short note about this trip']"
      )!,
      { target: { value: "Beach holiday" } }
    );
    fireEvent.change(names[0], { target: { value: "Alice" } });
    fireEvent.change(wallets[0], { target: { value: ADDR_A } });
    fireEvent.change(names[1], { target: { value: "Bob" } });
    fireEvent.change(wallets[1], { target: { value: ADDR_B } });

    clickSubmit(container);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data: TripFormData = onSubmit.mock.calls[0][0];
    expect(data.name).toBe("Bali 2025");
    expect(data.description).toBe("Beach holiday");
    expect(data.members.length).toBe(2);
    expect(data.members[0].name).toBe("Alice");
    expect(data.members[1].name).toBe("Bob");
  });

  it("trims trailing whitespace from member wallet addresses before submit", () => {
    const { container, onSubmit } = renderForm();
    const names = memberNameInputs(container);
    const wallets = walletInputs(container);

    fireEvent.change(tripNameInput(container), { target: { value: "Trip" } });
    fireEvent.change(names[0], { target: { value: "Alice" } });
    fireEvent.change(wallets[0], { target: { value: `  ${ADDR_A}  ` } });
    fireEvent.change(names[1], { target: { value: "Bob" } });
    fireEvent.change(wallets[1], { target: { value: ADDR_B } });

    clickSubmit(container);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data: TripFormData = onSubmit.mock.calls[0][0];
    expect(data.members[0].walletAddress).toBe(ADDR_A);
  });

  it("excludes unnamed members from the submitted data", () => {
    const { container, onSubmit } = renderForm();
    const names = memberNameInputs(container);
    const wallets = walletInputs(container);

    fireEvent.change(tripNameInput(container), { target: { value: "Trip" } });
    fireEvent.change(names[0], { target: { value: "Alice" } });
    fireEvent.change(wallets[0], { target: { value: ADDR_A } });
    fireEvent.change(names[1], { target: { value: "Bob" } });
    fireEvent.change(wallets[1], { target: { value: ADDR_B } });

    // Add a 3rd member but leave their name empty
    const addBtn = screen.getAllByRole("button", { name: /add (member|another member)/i })[0];
    fireEvent.click(addBtn);

    clickSubmit(container);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data: TripFormData = onSubmit.mock.calls[0][0];
    // Only 2 named members should be submitted
    expect(data.members.length).toBe(2);
  });
});

// ─── Cancel ───────────────────────────────────────────────────────────────────

describe("TripForm — cancel", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fires onCancel when the Cancel button is clicked", () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onSubmit when the user cancels", () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ─── Member management ────────────────────────────────────────────────────────

describe("TripForm — member management", () => {
  beforeEach(() => jest.clearAllMocks());

  it("adds a new member row when Add member is clicked", () => {
    const { container } = renderForm();
    const before = memberNameInputs(container).length;

    const addBtn = screen.getAllByRole("button", { name: /add (member|another member)/i })[0];
    fireEvent.click(addBtn);

    expect(memberNameInputs(container).length).toBe(before + 1);
  });

  it("removes a member row when trash button is clicked (if ≥ 3 members)", () => {
    const { container } = renderForm();
    // Add a third member first
    const addBtn = screen.getAllByRole("button", { name: /add (member|another member)/i })[0];
    fireEvent.click(addBtn);
    expect(memberNameInputs(container).length).toBe(3);

    // Find all non-disabled type="button" elements that contain an SVG (icon buttons)
    // and are NOT the "Add" or "Add member" / "Add another member" buttons
    const allTypeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[type='button']")
    );
    // Trash buttons: not disabled, contain SVG, don't include "Add" text
    const enabledIconBtns = allTypeButtons.filter(
      (btn) => !btn.disabled && btn.querySelector("svg") && !/add/i.test(btn.textContent ?? "")
    );

    // The last one is the trash button for the 3rd (newly added) member row
    fireEvent.click(enabledIconBtns[enabledIconBtns.length - 1]);

    expect(memberNameInputs(container).length).toBe(2);
  });

  it("keeps minimum 2 member rows (remove is disabled)", () => {
    const { container } = renderForm();
    expect(memberNameInputs(container).length).toBe(2);

    // All trash buttons for 2 members should be disabled
    const trashButtons = container.querySelectorAll<HTMLButtonElement>(
      "button[type='button'][disabled]"
    );
    expect(trashButtons.length).toBeGreaterThan(0);
  });
});

// ─── Pre-fill props ───────────────────────────────────────────────────────────

describe("TripForm — pre-fill from props", () => {
  beforeEach(() => jest.clearAllMocks());

  it("pre-fills member 1 name from currentUserName", () => {
    const { container } = renderForm({
      currentUserName: "Charlie",
      currentUserPublicKey: ADDR_A,
    });
    const names = memberNameInputs(container);
    expect(names[0].value).toBe("Charlie");
  });

  it("pre-fills member 1 wallet from currentUserPublicKey", () => {
    const { container } = renderForm({
      currentUserName: "Charlie",
      currentUserPublicKey: ADDR_A,
    });
    const wallets = walletInputs(container);
    expect(wallets[0].value).toBe(ADDR_A);
  });

  it("pre-fills all fields from initialData when initialData has ≥ 2 members", () => {
    const { container } = renderForm({
      initialData: {
        name: "Pre-filled Trip",
        description: "Great adventure",
        members: [
          { id: "x1", name: "Alice", walletAddress: ADDR_A },
          { id: "x2", name: "Bob",   walletAddress: ADDR_B },
        ],
      },
    });
    expect(tripNameInput(container).value).toBe("Pre-filled Trip");
    const names = memberNameInputs(container);
    expect(names[0].value).toBe("Alice");
    expect(names[1].value).toBe("Bob");
  });
});
