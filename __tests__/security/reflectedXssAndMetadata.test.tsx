/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import { generateTripMetadata } from "@/app/trips/[id]/page";
import { generateMetadata as generateLayoutMetadata } from "@/app/trips/[id]/layout";
import { ToastProvider, useToast } from "@/components/system/Toast";
import TripDetailPage from "@/app/trips/[id]/page";
import { useTrip } from "@/hooks/useTrip";
import { useExpense } from "@/hooks/useExpense";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/hooks/useWallet";
import { useParams } from "next/navigation";

// Mock dependencies
jest.mock("@/hooks/useTrip");
jest.mock("@/hooks/useExpense");
jest.mock("@/context/AuthContext");
jest.mock("@/hooks/useWallet");
jest.mock("next/navigation", () => ({
  useParams: jest.fn(),
}));

jest.mock("@/components/auth/AuthGuard", () => ({
  AuthGuard: ({ children }: any) => <div data-testid="auth-guard">{children}</div>,
}));

jest.mock("@/components/ui/Modal", () => ({
  Modal: ({ open, title, description, children }: any) =>
    open ? (
      <div data-testid="modal">
        <h2 data-testid="modal-title">{title}</h2>
        <p data-testid="modal-desc">{description}</p>
        {children}
      </div>
    ) : null,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

const mockUseTrip = useTrip as jest.Mock;
const mockUseExpense = useExpense as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;
const mockUseWallet = useWallet as jest.Mock;
const mockUseParams = useParams as jest.Mock;

describe("Security: Reflected XSS, Route Parameters, and Metadata Policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { displayName: "Alice" } });
    mockUseWallet.mockReturnValue({ publicKey: "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV" });
    mockUseExpense.mockReturnValue({ expenses: [] });
  });

  describe("Server-rendered Metadata Policy (generateTripMetadata)", () => {
    it("strips script tags and HTML injection from trip names", () => {
      const metadata = generateTripMetadata({
        tripName: `<script>alert('xss')</script>Tokyo Summer`,
      });

      expect(metadata.title).toBe("Tokyo Summer | Stellar Star");
      expect(metadata.title).not.toContain("<script>");
      expect(metadata.title).not.toContain("alert");
      expect(metadata.description).not.toContain("<script>");
    });

    it("sanitizes wallet labels to prevent attribute breakouts in meta tags", () => {
      const metadata = generateTripMetadata({
        tripName: "Kyoto Retreat",
        walletAddress: `GDQAX..." onfocus="alert(1)`,
      });

      expect(metadata.title).not.toContain('"');
      expect(metadata.title).not.toContain("onfocus");
      expect(metadata.title).toContain("Kyoto Retreat");
    });

    it("sanitizes user-controlled route parameters (tripId)", () => {
      const metadata = generateTripMetadata({
        tripId: `trip-123<img src=x onerror=alert(1)>`,
      });

      expect(metadata.title).toBe("Trip trip-123 | Stellar Star");
      expect(metadata.title).not.toContain("<img");
      expect(metadata.title).not.toContain("onerror");
    });

    it("enforces a Content Security Policy in metadata", () => {
      const metadata = generateTripMetadata({
        tripName: "Secure Trip",
      });

      expect(metadata.other?.["content-security-policy"]).toContain("default-src 'self'");
    });

    it("layout generateMetadata delegates cleanly with parameter promises", async () => {
      const metadata = await generateLayoutMetadata({
        params: Promise.resolve({ id: `<script>evil()</script>trip-safe-99` }),
        searchParams: Promise.resolve({
          name: `<b onmouseover=alert(1)>Bali Vacation</b>`,
          wallet: "GDQAX...<tag>",
        }),
      });

      expect(metadata.title).not.toContain("<script>");
      expect(metadata.title).not.toContain("<b");
      expect(metadata.title).toContain("Bali Vacation");
      expect(metadata.other?.["content-security-policy"]).toBeDefined();
    });
  });

  describe("Toast Notification Sanitization (components/system/Toast)", () => {
    function TestToastConsumer({ title, description }: { title: string; description?: string }) {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              variant: "error",
              title,
              description,
            })
          }
        >
          Trigger Toast
        </button>
      );
    }

    it("defangs HTML tags and script injections in toast title and description", () => {
      render(
        <ToastProvider>
          <TestToastConsumer
            title={`<script>steal()</script>Error in Trip "<svg onload=alert(1)>"`}
            description={`Details: <img src=x onerror=alert('stored-xss')> Failed.`}
          />
        </ToastProvider>,
      );

      const trigger = screen.getByText("Trigger Toast");
      act(() => {
        trigger.click();
      });

      const titleEl = screen.getByText(/Error in Trip/);
      expect(titleEl.textContent).not.toContain("<script>");
      expect(titleEl.textContent).not.toContain("<svg");
      expect(titleEl.textContent).not.toContain("onload");

      const descEl = screen.getByText(/Details:/);
      expect(descEl.textContent).not.toContain("<img");
      expect(descEl.textContent).not.toContain("onerror");
      expect(descEl.textContent).toContain("Failed.");
    });
  });

  describe("TripDetailPage Client Runtime Safety", () => {
    it("updates document.title with sanitized metadata and safe modal description", () => {
      mockUseParams.mockReturnValue({ id: `trip-<script>bad()</script>1` });
      mockUseTrip.mockReturnValue({
        getTrip: () => ({
          id: "trip-1",
          name: `<script>alert(1)</script>Beach Party 2026`,
          description: "Summer hangout",
          members: [
            { id: "m-alice", name: "Alice", walletAddress: "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV" },
          ],
          expenseIds: [],
          settled: false,
          createdByWallet: "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV",
        }),
        settleTrip: jest.fn(),
        addExpenseToTrip: jest.fn(),
        isLoading: false,
      });

      render(<TripDetailPage />);

      expect(document.title).toBe("Beach Party 2026 | Stellar Star");
      expect(document.title).not.toContain("<script>");

      // Navigation bar receives sanitized trip name
      const navHeader = screen.getByText("Beach Party 2026");
      expect(navHeader).toBeDefined();
      expect(navHeader.textContent).not.toContain("<script>");
    });
  });
});
