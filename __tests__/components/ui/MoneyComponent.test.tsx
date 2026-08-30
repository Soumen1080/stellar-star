/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { Money } from "@/components/ui/Money";
import { LocaleProvider } from "@/context/LocaleContext";

// Simple wrapper to provide locale context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

describe("<Money /> Component", () => {
  it("renders correctly with default props", () => {
    const { container } = render(
      <TestWrapper>
        <Money amount="100.25" asset="USD" />
      </TestWrapper>
    );

    // Default locale is en-US
    expect(container.textContent).toContain("$100.25");
  });

  it("applies class names and custom styling", () => {
    const { container } = render(
      <TestWrapper>
        <Money amount="15.00" asset="USD" className="text-red-500 font-bold" />
      </TestWrapper>
    );

    const spanElement = container.querySelector("span");
    expect(spanElement?.className).toContain("text-red-500");
    expect(spanElement?.className).toContain("font-bold");
  });

  it("handles direction owed (+) styling and accessibility labels", () => {
    const { container } = render(
      <TestWrapper>
        <Money amount="15.00" asset="USD" direction="owed" />
      </TestWrapper>
    );

    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    // Visual prefix should have "+"
    expect(cleanText).toContain("+$15.00");

    // Accessible description should announce direction and amount clearly
    const srOnlySpan = container.querySelector(".sr-only");
    expect(srOnlySpan).not.toBeNull();
    expect(srOnlySpan?.textContent?.toLowerCase()).toContain("you are owed 15.00 us dollar");
  });

  it("handles direction owe (-) styling and accessibility labels", () => {
    const { container } = render(
      <TestWrapper>
        <Money amount="42.50" asset="XLM" direction="owe" />
      </TestWrapper>
    );

    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    // Visual prefix should have "-"
    expect(cleanText).toContain("-XLM 42.5000");

    // Accessible description should announce direction and amount clearly
    const srOnlySpan = container.querySelector(".sr-only");
    expect(srOnlySpan).not.toBeNull();
    expect(srOnlySpan?.textContent).toBe("You owe 42.5000 Stellar Lumens");
  });

  it("supports exact values when showExact is true", () => {
    const { container } = render(
      <TestWrapper>
        <Money amount="1234567.890123" asset="XLM" showExact />
      </TestWrapper>
    );

    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("XLM 1,234,567.890123");
  });
});
