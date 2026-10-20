"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import {
  type Locale,
  type LocaleInfo,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isRTL as checkIsRTL,
  getDirection,
  translate,
  parseLocaleAmount,
  type ParseAmountResult,
  formatLocaleDate,
  formatLocaleDateTime,
  PRESET_OPTIONS,
  type DateFormatStyle,
} from "@/lib/i18n";

export type { Locale, LocaleInfo };
export { SUPPORTED_LOCALES };

interface LocaleContextType {
  locale: Locale;
  stableLocale: Locale;
  isHydrated: boolean;
  setLocale: (locale: Locale) => void;
  isRTL: boolean;
  dir: "rtl" | "ltr";
  t: (key: string, params?: Record<string, string | number>) => string;
  formatDate: (
    date: Date | string | number,
    options?: Intl.DateTimeFormatOptions | DateFormatStyle,
    freezeTimestamp?: boolean
  ) => string;
  formatDateTime: (date: Date | string | number, freezeTimestamp?: boolean) => string;
  parseAmount: (input: string) => ParseAmountResult;
}

const LocaleContext = createContext<LocaleContextType | undefined>(undefined);

const VALID_LOCALES: Locale[] = ["en-US", "de-DE", "hi-IN", "ja-JP", "ar-SA", "qps-ploc"];

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);

  useEffect(() => {
    setIsHydrated(true);
    const saved = localStorage.getItem("stellar-star-locale") as Locale;
    if (saved && VALID_LOCALES.includes(saved)) {
      setLocale(saved);
    } else if (typeof window !== "undefined" && window.navigator) {
      const browserLang = window.navigator.language?.toLowerCase() ?? "";
      if (browserLang.startsWith("de")) {
        setLocale("de-DE");
      } else if (browserLang.startsWith("hi")) {
        setLocale("hi-IN");
      } else if (browserLang.startsWith("ja")) {
        setLocale("ja-JP");
      } else if (browserLang.startsWith("ar")) {
        setLocale("ar-SA");
      } else {
        setLocale("en-US");
      }
    }
  }, []);

  const isRTL = useMemo(() => checkIsRTL(locale), [locale]);
  const dir = useMemo(() => getDirection(locale), [locale]);

  // Synchronize document attributes for accessibility and layout direction
  useEffect(() => {
    if (typeof document !== "undefined") {
      const langCode = locale === "qps-ploc" ? "en" : locale.split("-")[0];
      document.documentElement.lang = langCode;
      document.documentElement.dir = dir;
    }
  }, [locale, dir]);

  const handleSetLocale = useCallback((newLocale: Locale) => {
    setLocale(newLocale);
    try {
      localStorage.setItem("stellar-star-locale", newLocale);
    } catch {
      // Ignore localStorage errors in restricted environments
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      // Defer client-only translations until after hydration to prevent SSR mismatch
      const activeLocale = isHydrated ? locale : DEFAULT_LOCALE;
      return translate(activeLocale, key, params);
    },
    [locale, isHydrated]
  );

  const formatDate = useCallback(
    (
      date: Date | string | number,
      options?: Intl.DateTimeFormatOptions | DateFormatStyle,
      freezeTimestamp?: boolean
    ) => {
      const activeLocale = isHydrated ? locale : DEFAULT_LOCALE;
      const shouldFreezeTimezone = freezeTimestamp ?? !isHydrated;

      let resolvedOptions: Intl.DateTimeFormatOptions;
      if (typeof options === "string") {
        resolvedOptions = { ...(PRESET_OPTIONS[options] ?? PRESET_OPTIONS.medium) };
      } else if (options) {
        resolvedOptions = { ...options };
      } else {
        resolvedOptions = { ...PRESET_OPTIONS.medium };
      }

      // Freeze timezone to UTC during initial SSR/hydration pass to ensure identical output
      if (shouldFreezeTimezone && !resolvedOptions.timeZone) {
        resolvedOptions.timeZone = "UTC";
      }

      return formatLocaleDate(date, activeLocale, resolvedOptions);
    },
    [locale, isHydrated]
  );

  const formatDateTime = useCallback(
    (date: Date | string | number, freezeTimestamp?: boolean) => {
      const activeLocale = isHydrated ? locale : DEFAULT_LOCALE;
      const shouldFreezeTimezone = freezeTimestamp ?? !isHydrated;
      const options: Intl.DateTimeFormatOptions = {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(shouldFreezeTimezone ? { timeZone: "UTC" } : {}),
      };
      return formatLocaleDate(date, activeLocale, options);
    },
    [locale, isHydrated]
  );

  const parseAmount = useCallback(
    (input: string) => {
      const activeLocale = isHydrated ? locale : DEFAULT_LOCALE;
      return parseLocaleAmount(input, activeLocale);
    },
    [locale, isHydrated]
  );

  const contextValue = useMemo<LocaleContextType>(
    () => ({
      locale,
      stableLocale: DEFAULT_LOCALE,
      isHydrated,
      setLocale: handleSetLocale,
      isRTL,
      dir,
      t,
      formatDate,
      formatDateTime,
      parseAmount,
    }),
    [locale, isHydrated, handleSetLocale, isRTL, dir, t, formatDate, formatDateTime, parseAmount]
  );

  return <LocaleContext.Provider value={contextValue}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextType {
  const context = useContext(LocaleContext);
  if (!context) {
    // Safe default fallback for tests, SSR or static generation
    return {
      locale: DEFAULT_LOCALE,
      stableLocale: DEFAULT_LOCALE,
      isHydrated: true,
      setLocale: () => {},
      isRTL: false,
      dir: "ltr",
      t: (key: string, params?: Record<string, string | number>) =>
        translate(DEFAULT_LOCALE, key, params),
      formatDate: (
        date: Date | string | number,
        options?: Intl.DateTimeFormatOptions | DateFormatStyle,
        freezeTimestamp?: boolean
      ) => {
        const opts = typeof options === "string" ? PRESET_OPTIONS[options] : options;
        return formatLocaleDate(date, DEFAULT_LOCALE, {
          ...(opts ?? PRESET_OPTIONS.medium),
          ...(freezeTimestamp ? { timeZone: "UTC" } : {}),
        });
      },
      formatDateTime: (date: Date | string | number, freezeTimestamp?: boolean) =>
        formatLocaleDate(date, DEFAULT_LOCALE, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          ...(freezeTimestamp ? { timeZone: "UTC" } : {}),
        }),
      parseAmount: (input: string) => parseLocaleAmount(input, DEFAULT_LOCALE),
    };
  }
  return context;
}
