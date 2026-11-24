/**
 * __tests__/api/bodyLimits.test.ts
 *
 * Issue #418: API request and response byte limits.
 *
 *  - Media type is checked first (415), then declared length (413 / 400),
 *    then streamed bytes (413, with the stream cancelled), then UTF-8, JSON,
 *    depth and shape (400).
 *  - Fuzzing with random bytes, chunking, headers and broken streams never
 *    throws out of the boundary and never crashes a real handler.
 *  - Oversized responses are refused instead of serialized to the client.
 *  - No route under app/api parses a body directly.
 */

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import {
  DEFAULT_BODY_LIMIT_BYTES,
  MAX_JSON_DEPTH,
  RequestBodyError,
  bodyLimitFor,
  jsonDepth,
  limitedJson,
  parseJsonBody,
  readJsonBody,
  readLimitedBytes,
  readLimitedFormData,
  readTextBody,
  serializeBounded,
  ResponseTooLargeError,
} from "@/lib/api/bodyLimits";

const enc = new TextEncoder();

/** A request whose body arrives as the given chunks, optionally failing mid-stream. */
function streamed(
  chunks: Uint8Array[],
  headers: Record<string, string> = { "content-type": "application/json" },
  options: { failAfter?: number } = {},
) {
  let index = 0;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (options.failAfter !== undefined && index >= options.failAfter) {
        controller.error(new Error("socket hang up"));
        return;
      }
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const h = new Headers(headers);
  return {
    request: { headers: h, body },
    get pulls() {
      return pulls;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function jsonRequest(text: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return streamed([enc.encode(text)], headers).request;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "OK";
  } catch (err) {
    if (err instanceof RequestBodyError) return `${err.status}:${err.code}`;
    throw err;
  }
}

describe("readJsonBody: ordered checks", () => {
  it("parses a valid object", async () => {
    await expect(readJsonBody(jsonRequest('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it("accepts application/json with parameters and +json types", async () => {
    await expect(readJsonBody(jsonRequest("{}", { "content-type": "application/json; charset=utf-8" }))).resolves.toEqual({});
    await expect(readJsonBody(jsonRequest("{}", { "content-type": "application/merge-patch+json" }))).resolves.toEqual({});
  });

  it("returns 415 for a non-JSON media type without reading the body", async () => {
    const s = streamed([enc.encode('{"a":1}')], { "content-type": "text/plain" });
    expect(await code(readJsonBody(s.request))).toBe("415:UNSUPPORTED_MEDIA_TYPE");
    // A stream pre-pulls once when constructed; nothing beyond that is read.
    expect(s.pulls).toBeLessThanOrEqual(1);
  });

  it("returns 415 for a body with no media type", async () => {
    expect(await code(readJsonBody(jsonRequest('{"a":1}', {})))).toBe("415:UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 413 on a declared Content-Length over the cap, before reading", async () => {
    const s = streamed([enc.encode("{}")], { "content-type": "application/json", "content-length": "999999" });
    expect(await code(readJsonBody(s.request, { maxBytes: 1024 }))).toBe("413:BODY_TOO_LARGE");
    // A stream pre-pulls once when constructed; nothing beyond that is read.
    expect(s.pulls).toBeLessThanOrEqual(1);
  });

  it("returns 400 on a malformed Content-Length", async () => {
    for (const bad of ["-1", "12abc", "1e3", "0x10", "9".repeat(20)]) {
      const r = jsonRequest("{}", { "content-type": "application/json", "content-length": bad });
      expect({ bad, result: await code(readJsonBody(r)) }).toEqual({ bad, result: "400:INVALID_CONTENT_LENGTH" });
    }
  });

  it("returns 413 when streamed bytes pass the cap even if Content-Length lies, and cancels the stream", async () => {
    const chunk = new Uint8Array(512).fill(0x20);
    const s = streamed(Array.from({ length: 100 }, () => chunk), { "content-type": "application/json", "content-length": "10" });
    expect(await code(readJsonBody(s.request, { maxBytes: 2048 }))).toBe("413:BODY_TOO_LARGE");
    expect(s.cancelled).toBe(true);
    expect(s.pulls).toBeLessThan(10);
  });

  it("returns 400 for invalid UTF-8, invalid JSON, excessive depth and wrong shape", async () => {
    const badUtf8 = streamed([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]).request;
    expect(await code(readJsonBody(badUtf8))).toBe("400:INVALID_BODY_ENCODING");
    expect(await code(readJsonBody(jsonRequest("{nope")))).toBe("400:INVALID_JSON");
    const deep = "[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1);
    expect(await code(readJsonBody(jsonRequest(deep), { expect: "any" }))).toBe("400:JSON_TOO_DEEP");
    expect(await code(readJsonBody(jsonRequest("[1,2]")))).toBe("400:INVALID_BODY_SHAPE");
    expect(await code(readJsonBody(jsonRequest('"str"')))).toBe("400:INVALID_BODY_SHAPE");
    expect(await code(readJsonBody(jsonRequest('{"a":1}'), { validate: () => "a is wrong" }))).toBe("400:INVALID_BODY_SHAPE");
  });

  it("treats an empty body as required unless allowEmpty, with or without a media type", async () => {
    expect(await code(readJsonBody(jsonRequest("")))).toBe("400:BODY_REQUIRED");
    await expect(readJsonBody(jsonRequest(""), { allowEmpty: true })).resolves.toBeUndefined();
    await expect(readJsonBody({ headers: new Headers(), body: null }, { allowEmpty: true })).resolves.toBeUndefined();
  });

  it("returns 400 when the stream errors mid-read", async () => {
    const s = streamed([enc.encode('{"a":'), enc.encode("1}")], undefined, { failAfter: 1 });
    expect(await code(readJsonBody(s.request))).toBe("400:BODY_READ_FAILED");
  });

  it("reassembles multi-byte characters split across chunks", async () => {
    const bytes = enc.encode('{"name":"Zoë 🚀"}');
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    await expect(readJsonBody(streamed(chunks).request)).resolves.toEqual({ name: "Zoë 🚀" });
  });

  it("measures depth iteratively, so absurd nesting cannot overflow the stack", () => {
    let value: unknown = 1;
    for (let i = 0; i < 100_000; i++) value = [value];
    expect(jsonDepth(value)).toBeGreaterThan(MAX_JSON_DEPTH);
  });
});

describe("per-route caps", () => {
  it("uses a route's own cap and the default otherwise", () => {
    expect(bodyLimitFor("/api/expenses")).toBe(64 * 1024);
    expect(bodyLimitFor("/api/auth/refresh")).toBe(4 * 1024);
    expect(bodyLimitFor("/api/unknown")).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  it("parseJsonBody turns failures into responses in the flat or v1 envelope", async () => {
    const tooBig = jsonRequest(JSON.stringify({ x: "y".repeat(5000) }));
    const flat = await parseJsonBody(tooBig, { route: "/api/auth/refresh", requestId: "req-1" });
    expect(flat.ok).toBe(false);
    if (!flat.ok) {
      expect(flat.response.status).toBe(413);
      expect(flat.response.headers.get("x-max-body-bytes")).toBe(String(4 * 1024));
      expect(await flat.response.json()).toEqual({ error: expect.any(String), code: "BODY_TOO_LARGE", requestId: "req-1" });
    }
    const v1 = await parseJsonBody(jsonRequest("{}", { "content-type": "text/xml" }), { format: "v1" });
    if (!v1.ok) {
      expect(v1.response.status).toBe(415);
      expect(await v1.response.json()).toEqual({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: expect.any(String), status: 415 } });
    }
  });
});

describe("text and multipart bodies", () => {
  it("caps text bodies and rejects invalid UTF-8", async () => {
    await expect(readTextBody(jsonRequest("hello", {}), { maxBytes: 10 })).resolves.toBe("hello");
    expect(await code(readTextBody(jsonRequest("hello world!", {}), { maxBytes: 10 }))).toBe("413:BODY_TOO_LARGE");
  });

  it("caps multipart bodies as they stream and requires multipart/form-data", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(4096)]), "r.png");
    const real = new Request("http://localhost/x", { method: "POST", body: form });
    const ok = await readLimitedFormData(real as never, 64 * 1024);
    expect(ok.get("file")).toBeTruthy();
    const big = new Request("http://localhost/x", { method: "POST", body: form });
    expect(await code(readLimitedFormData(big as never, 1024))).toBe("413:BODY_TOO_LARGE");
    const json = new Request("http://localhost/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(await code(readLimitedFormData(json as never, 1024))).toBe("415:UNSUPPORTED_MEDIA_TYPE");
  });

  it("readLimitedBytes returns empty for a body-less request", async () => {
    expect((await readLimitedBytes({ headers: new Headers(), body: null }, 10)).byteLength).toBe(0);
  });
});

describe("response limits", () => {
  it("serializes under the cap and refuses over it", () => {
    expect(serializeBounded({ a: 1 }, 100)).toBe('{"a":1}');
    expect(() => serializeBounded({ a: "x".repeat(200) }, 100)).toThrow(ResponseTooLargeError);
  });

  it("limitedJson replaces an oversized body with a 500 and a stable code, keeping the request id", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const ok = limitedJson({ rows: [1, 2, 3] }, { status: 200, headers: { "x-request-id": "r-9" } }, 1024);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ rows: [1, 2, 3] });

    const huge = limitedJson({ rows: Array.from({ length: 10_000 }, (_, i) => ({ i, pad: "x".repeat(20) })) }, { headers: { "x-request-id": "r-9" } }, 1024);
    expect(huge.status).toBe(500);
    const body = await huge.json();
    expect(body).toEqual({ error: expect.any(String), code: "RESPONSE_TOO_LARGE", requestId: "r-9" });
    expect(JSON.stringify(body)).not.toContain("pad");
  });
});

// ─── Fuzzing ──────────────────────────────────────────────────────────────────

/** Small seeded PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBody(rand: () => number): Uint8Array {
  const kind = Math.floor(rand() * 6);
  if (kind === 0) return Uint8Array.from({ length: Math.floor(rand() * 4096) }, () => Math.floor(rand() * 256));
  if (kind === 1) return enc.encode(JSON.stringify({ a: "x".repeat(Math.floor(rand() * 40_000)) }));
  if (kind === 2) {
    const depth = Math.floor(rand() * 80);
    return enc.encode("[".repeat(depth) + "]".repeat(depth));
  }
  if (kind === 3) return enc.encode('{"a":"\\ud800' + "}".repeat(Math.floor(rand() * 5)));
  if (kind === 4) return enc.encode(JSON.stringify({ tripId: "t", amount: rand(), nested: { list: [1, 2, { x: null }] } }));
  return new Uint8Array(0);
}

function randomChunks(bytes: Uint8Array, rand: () => number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const size = 1 + Math.floor(rand() * 700);
    chunks.push(bytes.slice(i, i + size));
    i += size;
  }
  return chunks;
}

const TYPES = ["application/json", "application/json; charset=utf-8", "text/plain", "", "multipart/form-data; boundary=x", "application/x+json"];
const LENGTHS = [undefined, "0", "10", "999999999", "-4", "abc", ""];

describe("fuzz: the boundary never throws an unexpected error", () => {
  it("handles 2,000 random bodies, chunkings, headers and broken streams", async () => {
    const rand = rng(418);
    const seen = new Set<string>();
    for (let n = 0; n < 2000; n++) {
      const bytes = randomBody(rand);
      const headers: Record<string, string> = {};
      const type = TYPES[Math.floor(rand() * TYPES.length)];
      if (type) headers["content-type"] = type;
      const length = LENGTHS[Math.floor(rand() * LENGTHS.length)];
      if (length !== undefined) headers["content-length"] = length;
      const failAfter = rand() < 0.15 ? Math.floor(rand() * 3) : undefined;
      const s = streamed(randomChunks(bytes, rand), headers, { failAfter });

      const result = await parseJsonBody(s.request, { maxBytes: 16 * 1024, allowEmpty: rand() < 0.5, expect: "any" });
      if (result.ok) {
        seen.add("200");
      } else {
        expect([400, 413, 415]).toContain(result.response.status);
        seen.add(String(result.response.status));
      }
    }
    expect(seen).toEqual(new Set(["200", "400", "413", "415"]));
  });
});

describe("fuzz: real handlers answer malformed bodies with 4xx, never a crash", () => {
  const routes: Array<[string, string]> = [
    ["@/app/api/analytics/events/route", "/api/analytics/events"],
    ["@/app/api/auth/refresh/route", "/api/auth/refresh"],
    ["@/app/api/error-report/route", "/api/error-report"],
  ];

  it.each(routes)("%s", async (modulePath, url) => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = require(modulePath) as { POST: (r: NextRequest) => Promise<Response> };
    const rand = rng(url.length * 7919);
    for (let n = 0; n < 150; n++) {
      const bytes = randomBody(rand);
      const type = TYPES[Math.floor(rand() * TYPES.length)];
      const request = new NextRequest(`http://localhost${url}`, {
        method: "POST",
        headers: type ? { "content-type": type } : {},
        body: bytes.byteLength ? Buffer.from(bytes) : undefined,
      });
      const res = await POST(request);
      expect(res.status).toBeLessThan(500);
    }
  });
});

describe("no route parses a body directly", () => {
  const ROOT = path.resolve(__dirname, "../..");
  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return routeFiles(full);
      return e.name === "route.ts" ? [full] : [];
    });
  }

  it("every app/api route reads bodies through lib/api/bodyLimits", () => {
    const offenders = routeFiles(path.join(ROOT, "app/api")).filter((file) =>
      /\b(?:request|req)\.(?:json|text|formData|arrayBuffer|blob)\(\)/.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
