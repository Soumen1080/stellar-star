"use client";

import { getAccessToken } from "@/lib/supabase/session";

/** Saves text as a file in the browser. */
export function downloadText(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Leading BOM so spreadsheet apps read the CSV as UTF-8 (names, €, ₹). */
export const CSV_BOM = "﻿";

function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

/**
 * Requests a portable archive from the server, which scopes it to this
 * session's trips, rate-limits it and records it in the export audit log.
 */
export async function downloadArchive(tripIds?: string[]): Promise<void> {
  const token = getAccessToken();
  if (!token) throw new Error("Sign in with your wallet to export your trips.");

  const res = await fetch("/api/exports/archive", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(tripIds ? { tripIds } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error || `Export failed (${res.status}).`);
  }
  downloadText(
    fileNameFrom(res.headers.get("content-disposition"), "stellar-star-archive.json"),
    await res.text(),
    "application/json",
  );
}
