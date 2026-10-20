import { OPENAPI_SPEC, ACCOUNTING_SANDBOX_MAPPINGS } from "@/lib/api/openapi";

describe("OpenAPI 3.1.0 Specification & Accounting Mappings", () => {
  it("conforms to OpenAPI 3.1.0 schema requirements", () => {
    expect(OPENAPI_SPEC.openapi).toBe("3.1.0");
    expect(OPENAPI_SPEC.info.title).toBe("StellarStar Developer API");
    expect(OPENAPI_SPEC.info.version).toBe("1.0.0");
    expect(OPENAPI_SPEC.servers.length).toBeGreaterThan(0);
  });

  it("defines BearerAuth security scheme without service keys", () => {
    const bearer = OPENAPI_SPEC.components.securitySchemes.BearerAuth;
    expect(bearer.type).toBe("http");
    expect(bearer.scheme).toBe("bearer");
    expect(bearer.bearerFormat).toBe("stk_live_*");
  });

  it("documents required v1 paths and operations", () => {
    const paths = OPENAPI_SPEC.paths;
    expect(paths["/trips"]).toBeDefined();
    expect(paths["/trips"].get).toBeDefined();
    expect(paths["/trips"].post).toBeDefined();

    expect(paths["/expenses"]).toBeDefined();
    expect(paths["/expenses"].get).toBeDefined();
    expect(paths["/expenses"].post).toBeDefined();

    expect(paths["/webhooks"]).toBeDefined();
    expect(paths["/webhooks"].get).toBeDefined();
    expect(paths["/webhooks"].post).toBeDefined();
    expect(paths["/webhooks/test"]).toBeDefined();
    expect(paths["/webhooks/deliveries"]).toBeDefined();
  });

  it("provides working QuickBooks and Xero sandbox mappings", () => {
    expect(ACCOUNTING_SANDBOX_MAPPINGS.quickbooks.example.DocNumber).toBeTruthy();
    expect(ACCOUNTING_SANDBOX_MAPPINGS.quickbooks.example.Line.length).toBeGreaterThanOrEqual(2);

    expect(ACCOUNTING_SANDBOX_MAPPINGS.xero.example.Type).toBe("ACCPAY");
    expect(ACCOUNTING_SANDBOX_MAPPINGS.xero.example.LineItems.length).toBeGreaterThanOrEqual(1);
  });
});
