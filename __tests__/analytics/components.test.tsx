/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AnalyticsProvider, useAnalytics } from "@/context/AnalyticsContext";
import { ConsentBanner } from "@/components/analytics/ConsentBanner";
import { ConsentModal } from "@/components/analytics/ConsentModal";
import { AnalyticsDashboard } from "@/components/analytics/AnalyticsDashboard";
import { setStoredConsent } from "@/lib/analytics/consent";

describe("Analytics UI Components & Interaction", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("ConsentBanner", () => {
    it("renders when consent is pending and allows user to accept", () => {
      render(
        <AnalyticsProvider>
          <ConsentBanner />
        </AnalyticsProvider>
      );

      expect(screen.getByText("Privacy-First Product Analytics")).toBeTruthy();
      const acceptBtn = screen.getByText("Accept Analytics");

      act(() => {
        fireEvent.click(acceptBtn);
      });

      // Banner should disappear after accepting
      expect(screen.queryByText("Privacy-First Product Analytics")).toBeNull();
      expect(JSON.parse(localStorage.getItem("stellar-star-analytics-consent")!).status).toBe("granted");
    });

    it("allows user to decline analytics", () => {
      render(
        <AnalyticsProvider>
          <ConsentBanner />
        </AnalyticsProvider>
      );

      const declineBtn = screen.getByText("Decline");
      act(() => {
        fireEvent.click(declineBtn);
      });

      expect(screen.queryByText("Privacy-First Product Analytics")).toBeNull();
      expect(JSON.parse(localStorage.getItem("stellar-star-analytics-consent")!).status).toBe("denied");
    });
  });

  describe("ConsentModal & Preferences", () => {
    function ModalTestWrapper() {
      const { openConsentModal } = useAnalytics();
      return (
        <div>
          <button onClick={openConsentModal}>Open Settings</button>
          <ConsentModal />
        </div>
      );
    }

    it("opens and allows reviewing guarantees and toggling consent", () => {
      setStoredConsent(false);

      render(
        <AnalyticsProvider>
          <ModalTestWrapper />
        </AnalyticsProvider>
      );

      act(() => {
        fireEvent.click(screen.getByText("Open Settings"));
      });

      expect(screen.getByText("Privacy & Analytics Governance")).toBeTruthy();
      expect(screen.getByText("Zero Wallet Address Tracking")).toBeTruthy();
      expect(screen.getByText("Zero Transaction XDR")).toBeTruthy();

      const grantBtn = screen.getByText("Grant Consent");
      act(() => {
        fireEvent.click(grantBtn);
      });

      expect(screen.getByText("Analytics Active")).toBeTruthy();
      expect(screen.getByText("Revoke Consent")).toBeTruthy();
    });
  });

  describe("AnalyticsDashboard", () => {
    it("renders aggregate rate KPI cards and taxonomy tab", () => {
      render(
        <AnalyticsProvider>
          <AnalyticsDashboard />
        </AnalyticsProvider>
      );

      expect(screen.getByText("Product Analytics & Funnels")).toBeTruthy();
      expect(screen.getByText("Activation Rate")).toBeTruthy();
      expect(screen.getByText("Payment Completion")).toBeTruthy();
      expect(screen.getByText("Privacy & Redaction Verified")).toBeTruthy();

      // Switch to Public Event Taxonomy tab
      const taxonomyTab = screen.getByText("Public Event Taxonomy");
      act(() => {
        fireEvent.click(taxonomyTab);
      });

      expect(screen.getByText("Public Non-Sensitive Event Taxonomy")).toBeTruthy();
      expect(screen.getByText("wallet_connected")).toBeTruthy();
      expect(screen.getByText("payment_completed")).toBeTruthy();
    });
  });
});
