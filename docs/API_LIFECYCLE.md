# Developer API lifecycle and compatibility

The `/api/v1` contract is additive for its lifetime. New optional fields, operations, and enum values may be added without changing the major version. Removing or renaming fields or operations, changing field types, narrowing accepted values, changing required inputs, changing auth scopes, or removing a documented response is a breaking change and requires a new `/api/v2` surface.

For a breaking retirement, publish a migration guide and announce the deprecation at least 180 days before the planned sunset. Configure `API_V1_DEPRECATION_DATE` and `API_V1_SUNSET_DATE` only after the dates are announced. The API middleware then sends the RFC 9745 `Deprecation` and RFC 8594 `Sunset` headers with a link to this policy. Missing dates mean the version is active and the headers are omitted.

`docs/api/openapi-v1.snapshot.json` is the reviewed compatibility baseline. CI compares the current OpenAPI document with this snapshot and rejects removed operations, required parameters, required schema properties, enum values, response codes, or changed schema types. Additions are allowed. Review any intentional breaking change by introducing a new versioned API and keep the v1 baseline intact. Update the snapshot only for reviewed additive changes by running `node scripts/check-openapi-compat.mjs --update`.

Every OpenAPI operation includes an `x-api-contract` declaration for authentication, pagination, error statuses, idempotency, and rate/page limits. Representative request, paginated response, and error fixtures live in `docs/api/fixtures/`.

Bearer token endpoints are limited to 60 requests per minute per token and IP. Token management endpoints are limited to 20 requests per minute per wallet and IP. Collection endpoints accept a `limit` of at most 100 where pagination is supported; the OpenAPI declaration identifies the endpoint-specific paging parameters.
