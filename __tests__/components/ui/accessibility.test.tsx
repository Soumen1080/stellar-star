/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";

const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>);
MotionDiv.displayName = "MotionDiv";
jest.mock("framer-motion", () => ({
  motion: { div: MotionDiv },
}));

describe("accessible shared controls", () => {
  it("associates field errors and hints with their input", () => {
    const { rerender } = render(<Input label="Amount" hint="Enter a value" />);
    const field = screen.getByLabelText("Amount");
    expect(field.getAttribute("aria-describedby")).toBe("amount-hint");
    expect(field.getAttribute("aria-invalid")).not.toBe("true");

    rerender(<Input label="Amount" error="Enter a valid amount" />);
    expect(screen.getByLabelText("Amount").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("Enter a valid amount");
    expect(screen.getByLabelText("Amount").getAttribute("aria-describedby")).toBe("amount-error");
  });

  it("exposes a named modal and lets Escape close it", () => {
    const onClose = jest.fn();
    render(<Modal open onClose={onClose} title="Confirm payment" description="Review before signing">Details</Modal>);
    expect(screen.getByRole("dialog", { name: "Confirm payment" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close modal" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
