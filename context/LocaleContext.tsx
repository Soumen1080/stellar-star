"use client";

import React, { createContext, useContext, useState, useEffect } from "react";

export type Locale = "en-US" | "de-DE" | "hi-IN" | "ja-JP";

interface LocaleContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextType | undefined>(undefined);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en-US");

  useEffect(() => {
    const saved = localStorage.getItem("stellar-star-locale") as Locale;
    if (saved && ["en-US", "de-DE", "hi-IN", "ja-JP"].includes(saved)) {
      setLocale(saved);
    } else if (typeof window !== "undefined" && window.navigator) {
      const browserLang = window.navigator.language;
      if (browserLang.startsWith("de")) {
        setLocale("de-DE");
      } else if (browserLang.startsWith("hi")) {
        setLocale("hi-IN");
      } else if (browserLang.startsWith("ja")) {
        setLocale("ja-JP");
      } else {
        setLocale("en-US");
      }
    }
  }, []);

  const handleSetLocale = (newLocale: Locale) => {
    setLocale(newLocale);
    localStorage.setItem("stellar-star-locale", newLocale);
  };

  return (
    <LocaleContext.Provider value={{ locale, setLocale: handleSetLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    // Safe default fallback for tests, SSR or static generation
    return { locale: "en-US" as Locale, setLocale: () => {} };
  }
  return context;
}
