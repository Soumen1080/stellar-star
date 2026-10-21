import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

if (!base.webServer || Array.isArray(base.webServer)) throw new Error("Receipt tests require one app server.");
const server = base.webServer;

export default defineConfig({
  ...base,
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  testMatch: "**/receipt-ocr.spec.ts",
  projects: [
    { name: "receipt-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "receipt-android", use: { ...devices["Pixel 5"] } },
    { name: "receipt-ios", use: { ...devices["iPhone 12"] } },
  ],
  webServer: {
    ...server,
    env: { ...server.env, NEXT_PUBLIC_RECEIPT_OCR_ENABLED: "true" },
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
