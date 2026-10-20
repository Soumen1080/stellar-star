/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import { LocaleProvider, useLocale } from "@/context/LocaleContext";

function TestConsumer() {
  const { locale, setLocale, isRTL, dir, t, formatDate, parseAmount } = useLocale();

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="isRTL">{String(isRTL)}</span>
      <span data-testid="translation">{t("nav.features")}</span>
      <span data-testid="date">{formatDate("2026-10-21T00:00:00.000Z", "short")}</span>
      <span data-testid="parsed">{parseAmount("12,50").canonicalAmount}</span>
      <button onClick={() => setLocale("ar-SA")}>Switch to AR</button>
      <button onClick={() => setLocale("de-DE")}>Switch to DE</button>
      <button onClick={() => setLocale("qps-ploc")}>Switch to Pseudo</button>
    </div>
  );
}

describe("LocaleContext & LocaleProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
  });

  it("provides default locale en-US and ltr direction", () => {
    render(
      <LocaleProvider>
        <TestConsumer />
      </LocaleProvider>
    );

    expect(screen.getByTestId("locale").textContent).toBe("en-US");
    expect(screen.getByTestId("dir").textContent).toBe("ltr");
    expect(screen.getByTestId("isRTL").textContent).toBe("false");
    expect(screen.getByTestId("translation").textContent).toBe("Features");
  });

  it("updates HTML attributes and localStorage when changing to RTL Arabic", () => {
    render(
      <LocaleProvider>
        <TestConsumer />
      </LocaleProvider>
    );

    act(() => {
      screen.getByText("Switch to AR").click();
    });

    expect(screen.getByTestId("locale").textContent).toBe("ar-SA");
    expect(screen.getByTestId("dir").textContent).toBe("rtl");
    expect(screen.getByTestId("isRTL").textContent).toBe("true");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(localStorage.getItem("stellar-star-locale")).toBe("ar-SA");
  });

  it("formats dates and amounts dynamically according to selected locale", () => {
    render(
      <LocaleProvider>
        <TestConsumer />
      </LocaleProvider>
    );

    act(() => {
      screen.getByText("Switch to DE").click();
    });

    expect(screen.getByTestId("locale").textContent).toBe("de-DE");
    expect(screen.getByTestId("translation").textContent).toBe("Funktionen");
    // In de-DE, "12,50" is successfully parsed to canonical "12.50"
    expect(screen.getByTestId("parsed").textContent).toBe("12.50");
  });

  it("supports pseudo-localization mode dynamically", () => {
    render(
      <LocaleProvider>
        <TestConsumer />
      </LocaleProvider>
    );

    act(() => {
      screen.getByText("Switch to Pseudo").click();
    });

    expect(screen.getByTestId("locale").textContent).toBe("qps-ploc");
    const trans = screen.getByTestId("translation").textContent!;
    expect(trans.startsWith("[!!! ")).toBe(true);
    expect(trans.endsWith(" !!!]")).toBe(true);
  });
});
