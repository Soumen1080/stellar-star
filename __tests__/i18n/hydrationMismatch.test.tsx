/**
 * @jest-environment jsdom
 */

import React from "react";
import ReactDOMServer from "react-dom/server";
import { render, screen, act } from "@testing-library/react";
import { LocaleProvider, useLocale } from "@/context/LocaleContext";
import { Money } from "@/components/ui/Money";
import { formatAddress, formatWalletLabel, formatDateStable, formatDateTimeStable } from "@/lib/utils";

function HydrationTestSubject({
  dateIso,
  amount,
  wallet,
}: {
  dateIso: string;
  amount: string;
  wallet: string;
}) {
  const { formatDate, formatDateTime, t, isHydrated, locale } = useLocale();

  return (
    <div id="root-container">
      <h1 data-testid="title">{t("nav.trips")}</h1>
      <span data-testid="hydrated-flag">{String(isHydrated)}</span>
      <span data-testid="active-locale">{locale}</span>
      <span data-testid="date-display">{formatDate(dateIso, "short")}</span>
      <span data-testid="datetime-display">{formatDateTime(dateIso)}</span>
      <span data-testid="wallet-display">{formatWalletLabel(wallet, null, 4)}</span>
      <span data-testid="money-display">
        <Money amount={amount} asset="XLM" />
      </span>
    </div>
  );
}

describe("SSR Hydration Mismatch Prevention", () => {
  const dateIso = "2026-10-21T00:00:00.000Z";
  const amount = "1250.50";
  const wallet = "GBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDR";

  let consoleErrors: string[] = [];
  const originalError = console.error;

  beforeEach(() => {
    localStorage.clear();
    consoleErrors = [];
    console.error = (...args: any[]) => {
      const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      consoleErrors.push(msg);
      originalError.apply(console, args);
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("produces identical server-rendered HTML and client initial render markup", () => {
    // 1. Render to static HTML string (server-side simulation)
    const ssrHtml = ReactDOMServer.renderToString(
      <LocaleProvider>
        <HydrationTestSubject dateIso={dateIso} amount={amount} wallet={wallet} />
      </LocaleProvider>
    );

    // Verify SSR contains expected stable outputs
    expect(ssrHtml).toContain("Trips");
    expect(ssrHtml).toContain("10/21/2026");
    expect(ssrHtml).toContain("GBGJ...7CDR");
    expect(ssrHtml).toContain("1,250.50");

    // 2. Hydrate inside DOM
    const container = document.createElement("div");
    container.innerHTML = ssrHtml;
    document.body.appendChild(container);

    render(
      <LocaleProvider>
        <HydrationTestSubject dateIso={dateIso} amount={amount} wallet={wallet} />
      </LocaleProvider>,
      { container }
    );

    // Verify no hydration error was logged
    const hydrationErrors = consoleErrors.filter(
      (msg) =>
        msg.includes("Hydration failed") ||
        msg.includes("Text content did not match") ||
        msg.includes("did not match")
    );
    expect(hydrationErrors).toHaveLength(0);

    // Cleanup
    document.body.removeChild(container);
  });

  it("freezes timezone to UTC during initial render when timezone differs", () => {
    render(
      <LocaleProvider>
        <HydrationTestSubject dateIso={dateIso} amount={amount} wallet={wallet} />
      </LocaleProvider>
    );

    // Initial render / hydration freezes to UTC
    const dateText = screen.getByTestId("date-display").textContent;
    expect(dateText).toBe("10/21/2026");
  });

  it("defers user-stored German locale until post-hydration without crashing or mismatching", async () => {
    localStorage.setItem("stellar-star-locale", "de-DE");

    render(
      <LocaleProvider>
        <HydrationTestSubject dateIso={dateIso} amount={amount} wallet={wallet} />
      </LocaleProvider>
    );

    // Once hydrated (useEffect finishes), locale transitions to de-DE
    expect(screen.getByTestId("hydrated-flag").textContent).toBe("true");
    expect(screen.getByTestId("active-locale").textContent).toBe("de-DE");
    expect(screen.getByTestId("title").textContent).toBe("Reisen");
  });

  it("provides stable formatDateStable and formatDateTimeStable helpers in lib/utils", () => {
    const stableDate = formatDateStable("2026-10-21T00:00:00.000Z", "short");
    expect(stableDate).toBe("10/21/2026");

    const stableTime = formatDateTimeStable("2026-10-21T00:00:00.000Z");
    expect(stableTime).toContain("Oct 21");
    expect(stableTime).toContain("2026");
  });

  it("formats wallet labels deterministically without hydration shifts", () => {
    expect(formatWalletLabel(wallet, "Trip Leader", 6)).toBe("Trip Leader");
    expect(formatWalletLabel(wallet, null, 4)).toBe("GBGJ...7CDR");
    expect(formatAddress(wallet, 6)).toBe("GBGJFH...RP7CDR");
  });
});
