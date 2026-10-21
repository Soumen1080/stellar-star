import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Synthetic receipt only. Never write real receipt contents or images to disk.
const root = process.cwd();
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><body><script src="/engine.js"></script></body></html>');
      return;
    }
    let file;
    if (pathname === "/engine.js") file = path.join(root, "node_modules/tesseract.js/dist/tesseract.min.js");
    else if (/^\/ocr\/(?:core\/)?[a-zA-Z0-9._-]+$/.test(pathname)) file = path.join(root, "public", pathname);
    else { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const external = [];
  context.on("request", (request) => {
    if (!request.url().startsWith(origin + "/")) external.push(request.url());
  });
  await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 900; canvas.height = 500;
    const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 900, 500);
    context.fillStyle = "black"; context.font = "36px monospace";
    ["CAFE EXAMPLE", "2026-10-20", "Coffee 3.50", "Cake 4.00", "TOTAL USD 7.50"].forEach((line, i) => context.fillText(line, 40, 70 + i * 75));
    const worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: `${location.origin}/ocr/worker.min.js`, corePath: `${location.origin}/ocr/core`,
      langPath: `${location.origin}/ocr`, cacheMethod: "none", workerBlobURL: false,
    });
    try { return (await worker.recognize(canvas)).data.text; }
    finally { await worker.terminate(); }
  });
  assert.match(result, /CAFE EXAMPLE/);
  assert.match(result, /2026-10-20/);
  assert.match(result, /TOTAL USD 7\.50/);
  assert.deepEqual(external, []);
  console.log("PASS: real Chromium OCR recognized synthetic merchant/date/total using only same-origin assets.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
