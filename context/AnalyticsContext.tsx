"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import {
  type ConsentSettings,
  type AnalyticsEventName,
  type EventPropertiesMap,
  type AggregateMetrics,
  getStoredConsent,
  setStoredConsent,
  trackAnalyticsEvent,
  computeAggregateMetrics,
  getStoredEvents,
} from "@/lib/analytics";

interface AnalyticsContextType {
  consent: ConsentSettings;
  updateConsent: (granted: boolean) => void;
  track: <TName extends AnalyticsEventName>(name: TName, properties: EventPropertiesMap[TName]) => boolean;
  isConsentBannerOpen: boolean;
  closeConsentBanner: () => void;
  isConsentModalOpen: boolean;
  openConsentModal: () => void;
  closeConsentModal: () => void;
  metrics: AggregateMetrics;
  refreshMetrics: () => void;
}

const AnalyticsContext = createContext<AnalyticsContextType | undefined>(undefined);

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const [consent, setConsent] = useState<ConsentSettings>(() => getStoredConsent());
  const [isConsentBannerOpen, setIsConsentBannerOpen] = useState(false);
  const [isConsentModalOpen, setIsConsentModalOpen] = useState(false);
  const [metrics, setMetrics] = useState<AggregateMetrics>(() => computeAggregateMetrics(getStoredEvents()));

  useEffect(() => {
    const current = getStoredConsent();
    setConsent(current);
    // Show banner if consent status is pending
    if (current.status === "pending") {
      setIsConsentBannerOpen(true);
    }
  }, []);

  const refreshMetrics = useCallback(() => {
    const events = getStoredEvents();
    setMetrics(computeAggregateMetrics(events));
  }, []);

  const updateConsent = useCallback((granted: boolean) => {
    const next = setStoredConsent(granted);
    setConsent(next);
    setIsConsentBannerOpen(false);
    refreshMetrics();

    if (granted) {
      // Fire app_loaded upon initial consent
      trackAnalyticsEvent("app_loaded", {
        locale: typeof window !== "undefined" ? window.navigator?.language || "en-US" : "en-US",
        referrer_type: "direct",
      });
    }
  }, [refreshMetrics]);

  const track = useCallback(
    <TName extends AnalyticsEventName>(name: TName, properties: EventPropertiesMap[TName]) => {
      const ok = trackAnalyticsEvent(name, properties);
      if (ok) refreshMetrics();
      return ok;
    },
    [refreshMetrics]
  );

  const closeConsentBanner = useCallback(() => {
    setIsConsentBannerOpen(false);
  }, []);

  const openConsentModal = useCallback(() => {
    setIsConsentModalOpen(true);
  }, []);

  const closeConsentModal = useCallback(() => {
    setIsConsentModalOpen(false);
  }, []);

  const value = useMemo<AnalyticsContextType>(
    () => ({
      consent,
      updateConsent,
      track,
      isConsentBannerOpen,
      closeConsentBanner,
      isConsentModalOpen,
      openConsentModal,
      closeConsentModal,
      metrics,
      refreshMetrics,
    }),
    [
      consent,
      updateConsent,
      track,
      isConsentBannerOpen,
      closeConsentBanner,
      isConsentModalOpen,
      openConsentModal,
      closeConsentModal,
      metrics,
      refreshMetrics,
    ]
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics(): AnalyticsContextType {
  const context = useContext(AnalyticsContext);
  if (!context) {
    // Graceful fallback for tests, SSR or static generation
    return {
      consent: {
        status: "denied",
        analytics: false,
        timestamp: new Date().toISOString(),
        region: "strict",
      },
      updateConsent: () => {},
      track: () => false,
      isConsentBannerOpen: false,
      closeConsentBanner: () => {},
      isConsentModalOpen: false,
      openConsentModal: () => {},
      closeConsentModal: () => {},
      metrics: computeAggregateMetrics([]),
      refreshMetrics: () => {},
    };
  }
  return context;
}
