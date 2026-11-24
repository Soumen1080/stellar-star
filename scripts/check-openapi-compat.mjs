#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "lib/api/openapi.ts");
const snapshotPath = path.join(root, "docs/api/openapi-v1.snapshot.json");
const source = fs.readFileSync(sourcePath, "utf8");
const prefix = "export const OPENAPI_SPEC =";
const prefixIndex = source.indexOf(prefix);
const start = prefixIndex + prefix.length;
const end = source.indexOf(" as const;", start);
if (prefixIndex < 0 || end < 0) throw new Error("Unable to extract OPENAPI_SPEC.");
const spec = vm.runInNewContext(`(${source.slice(start, end)})`, Object.create(null), { timeout: 1000 });
for (const pathItem of Object.values(spec.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
    const operation = pathItem[method];
    if (!operation) continue;
    operation.responses ??= {};
    operation.responses["400"] ??= { $ref: "#/components/responses/BadRequestError" };
    operation.responses["401"] ??= { $ref: "#/components/responses/UnauthorizedError" };
    operation.responses["403"] ??= { $ref: "#/components/responses/ForbiddenError" };
    operation.responses["429"] ??= { $ref: "#/components/responses/RateLimitError" };
    const parameters = operation.parameters ?? [];
    const pageLimit = parameters.find((parameter) => parameter.name === "limit" && parameter.in === "query");
    const idempotency = parameters.find((parameter) => parameter.name.toLowerCase() === "idempotency-key" && parameter.in === "header");
    const route = Object.entries(spec.paths).find(([, candidate]) => candidate === pathItem)?.[0] ?? "";
    const tokenManagement = route.startsWith("/tokens");
    const scopes = {
      "GET /trips": ["trips:read"], "POST /trips": ["trips:write"], "GET /trips/{id}": ["trips:read"],
      "GET /expenses": ["expenses:read"], "POST /expenses": ["expenses:write"], "GET /settlements": ["settlement:read"],
      "GET /webhooks": ["webhooks:manage"], "POST /webhooks": ["webhooks:manage"], "DELETE /webhooks/{id}": ["webhooks:manage"],
      "POST /webhooks/test": ["webhooks:manage"], "GET /webhooks/deliveries": ["webhooks:manage"],
    };
    operation["x-api-contract"] = {
      authentication: tokenManagement
        ? { mode: "wallet session or X-Wallet-Address; POST /tokens also accepts wallet_address in the body" }
        : { scheme: "BearerAuth", requiredScopes: scopes[`${method.toUpperCase()} ${route}`] ?? [] },
      pagination: { supported: Boolean(pageLimit), limitParameter: pageLimit?.name ?? null, cursorParameter: parameters.find((parameter) => parameter.name === "cursor")?.name ?? null },
      errors: Object.keys(operation.responses).filter((status) => Number(status) >= 400),
      idempotency: idempotency ? { supported: true, header: idempotency.name } : { supported: false, header: null },
      limits: { rateLimit: tokenManagement ? "20 requests per minute per wallet and IP" : "60 requests per minute per token and IP", pageSize: pageLimit?.schema?.maximum ?? null },
    };
  }
}

if (process.argv.includes("--update")) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(spec, null, 2)}\n`);
  process.stdout.write("Updated the reviewed OpenAPI v1 snapshot.\n");
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const issues = [];
const has = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

function resolveSchema(schema, document) {
  if (!schema?.$ref) return schema;
  const parts = schema.$ref.replace(/^#\//, "").split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.reduce((value, part) => value?.[part], document);
}

function checkSchema(oldValue, nextValue, where) {
  const oldSchema = resolveSchema(oldValue, baseline);
  const nextSchema = resolveSchema(nextValue, spec);
  if (!oldSchema || !nextSchema) return;
  if (oldSchema.type && nextSchema.type !== oldSchema.type) issues.push(`${where}: schema type changed`);
  for (const value of oldSchema.enum ?? []) if (!(nextSchema.enum ?? []).includes(value)) issues.push(`${where}: enum value removed (${value})`);
  for (const field of nextSchema.required ?? []) if (!(oldSchema.required ?? []).includes(field)) issues.push(`${where}: new required field added (${field})`);
  for (const [name, oldProperty] of Object.entries(oldSchema.properties ?? {})) {
    if (!has(nextSchema.properties, name)) issues.push(`${where}: request/response property removed (${name})`);
    else checkSchema(oldProperty, nextSchema.properties[name], `${where}.${name}`);
  }
  if (oldSchema.items) checkSchema(oldSchema.items, nextSchema.items, `${where}[]`);
}

for (const [route, oldPath] of Object.entries(baseline.paths ?? {})) {
  const nextPath = spec.paths?.[route];
  if (!nextPath) { issues.push(`${route}: path removed`); continue; }
  for (const method of methods) {
    const oldOp = oldPath[method];
    if (!oldOp) continue;
    const nextOp = nextPath[method];
    if (!nextOp) { issues.push(`${method.toUpperCase()} ${route}: operation removed`); continue; }
    if (JSON.stringify(oldOp.security ?? baseline.security) !== JSON.stringify(nextOp.security ?? spec.security)) issues.push(`${method.toUpperCase()} ${route}: auth requirements changed`);
    for (const parameter of oldOp.parameters ?? []) {
      const replacement = (nextOp.parameters ?? []).find((candidate) => candidate.name === parameter.name && candidate.in === parameter.in);
      if (!replacement) issues.push(`${method.toUpperCase()} ${route}: parameter removed (${parameter.name})`);
      if (replacement) checkSchema(parameter.schema, replacement.schema, `${method.toUpperCase()} ${route} parameter ${parameter.name}`);
    }
    for (const parameter of nextOp.parameters ?? []) {
      const existed = (oldOp.parameters ?? []).some((candidate) => candidate.name === parameter.name && candidate.in === parameter.in);
      if (!existed && parameter.required) issues.push(`${method.toUpperCase()} ${route}: new required parameter added (${parameter.name})`);
    }
    if (oldOp.requestBody && !nextOp.requestBody) issues.push(`${method.toUpperCase()} ${route}: request body removed`);
    if (oldOp.requestBody?.required && !nextOp.requestBody?.required) issues.push(`${method.toUpperCase()} ${route}: request body is no longer required`);
    const oldRequestSchema = oldOp.requestBody?.content?.["application/json"]?.schema;
    const nextRequestSchema = nextOp.requestBody?.content?.["application/json"]?.schema;
    if (oldRequestSchema && !nextRequestSchema) issues.push(`${method.toUpperCase()} ${route}: request schema removed`);
    checkSchema(oldRequestSchema, nextRequestSchema, `${method.toUpperCase()} ${route} request`);
    for (const [status, oldResponse] of Object.entries(oldOp.responses ?? {})) {
      if (!has(nextOp.responses, status)) issues.push(`${method.toUpperCase()} ${route}: response status removed (${status})`);
      const oldSchema = oldResponse?.content?.["application/json"]?.schema;
      const nextSchema = nextOp.responses?.[status]?.content?.["application/json"]?.schema;
      if (oldSchema?.$ref && (!nextSchema?.$ref || oldSchema.$ref !== nextSchema.$ref)) issues.push(`${method.toUpperCase()} ${route}: response schema reference changed (${status})`);
      if (oldSchema && !nextSchema) issues.push(`${method.toUpperCase()} ${route}: response schema removed (${status})`);
      if (!oldSchema?.$ref && oldSchema) checkSchema(oldSchema, nextSchema, `${method.toUpperCase()} ${route} response ${status}`);
    }
  }
}

for (const [name, oldSchema] of Object.entries(baseline.components?.schemas ?? {})) {
  checkSchema(oldSchema, spec.components?.schemas?.[name], `component schema ${name}`);
}

if (issues.length) {
  process.stderr.write(`OpenAPI v1 breaking changes detected:\n${issues.map((issue) => `- ${issue}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("OpenAPI v1 is backward compatible with the reviewed snapshot.\n");
