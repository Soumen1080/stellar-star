# API request and response byte limits (#418)

Calling `request.json()` or `request.text()` buffers and parses the whole body
before any validation runs. A large, slow or deeply nested body therefore costs
memory and CPU even when the route is about to reject it. Every route under
`app/api` now reads its body through `lib/api/bodyLimits.ts`, which applies
these checks in order:

| Check | Failure | Status | Code |
| --- | --- | --- | --- |
| Media type: `application/json` or `application/*+json` (multipart for uploads) | wrong or missing type on a body | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| Declared `Content-Length` | malformed | 400 | `INVALID_CONTENT_LENGTH` |
| Declared `Content-Length` | above the route cap (nothing is read) | 413 | `BODY_TOO_LARGE` |
| Streamed bytes (counted per chunk, stream cancelled at the cap) | above the route cap, whatever the header said | 413 | `BODY_TOO_LARGE` |
| Stream integrity | the stream errors mid-read | 400 | `BODY_READ_FAILED` |
| Strict UTF-8 | invalid sequences | 400 | `INVALID_BODY_ENCODING` |
| JSON | does not parse | 400 | `INVALID_JSON` |
| Nesting depth (iterative, at most 32) | deeper | 400 | `JSON_TOO_DEEP` |
| Shape (object by default) and optional `validate` | wrong shape | 400 | `INVALID_BODY_SHAPE` |

A 413 carries `X-Max-Body-Bytes`. Routes keep their own envelope: `flat`
(`{ error, code, requestId? }`) or the developer API's `v1`
(`{ error: { code, message, status } }`).

## Caps

Per-route caps are in `ROUTE_BODY_LIMITS`. Routes without an entry get 16 KiB
(`DEFAULT_BODY_LIMIT_BYTES`). Expense and trip writes allow 64 KiB, auth
4–8 KiB, and error reports 32 KiB. Error reports are beacons, so they accept
any media type and only the byte cap applies. Receipt uploads are counted as
they stream, up to `RECEIPT_MAX_BYTES` plus 64 KiB of multipart overhead,
before `formData()` parses them.

## Responses

`limitedJson(body, init, maxBytes)` is a drop-in for `NextResponse.json`. It
serializes once and measures the result. Above the cap it returns `500
RESPONSE_TOO_LARGE` and logs the size, never the data. It is used by the
collection and export routes: account export, support audit logs, the v1 lists
and the reconciliation report. Caps are in `ROUTE_RESPONSE_LIMITS`, and the
default is 2 MiB. The archive export refuses with 413 above 25 MiB and asks
for fewer trips per request.

## Evidence

`__tests__/api/bodyLimits.test.ts`:

- Every row of the table above, including a lying `Content-Length` and the
  stream being cancelled.
- Multi-byte characters split across chunks.
- A seeded fuzz of 2,000 random bodies, chunkings, media types, lengths and
  broken streams. It only ever produces 200/400/413/415.
- A handler-level fuzz of three real routes. They never return 5xx.
- Response caps.
- A static guard that fails CI if any `app/api/**/route.ts` calls
  `.json()`, `.text()`, `.formData()`, `.arrayBuffer()` or `.blob()` on a
  request directly.
