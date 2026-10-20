/**
 * OpenAPI 3.1.0 specification for the StellarStar Developer API v1.
 * Stable, versioned schema with sandbox examples and accounting integration mappings.
 */

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "StellarStar Developer API",
    version: "1.0.0",
    description:
      "Versioned API and Webhook platform for trusted accounting integrations, event organizers, and expense sync.",
    contact: {
      name: "StellarStar Platform Engineering",
      url: "https://stellarstar.app/developer",
    },
    license: {
      name: "MIT",
    },
  },
  servers: [
    {
      url: "/api/v1",
      description: "Current environment API v1 endpoint",
    },
  ],
  security: [
    {
      BearerAuth: [],
    },
  ],
  paths: {
    "/trips": {
      get: {
        summary: "List permitted trips",
        description:
          "Returns paginated trips where the authenticated wallet is either the creator or a member.",
        operationId: "listTrips",
        parameters: [
          {
            name: "limit",
            in: "query",
            description: "Number of records to return (1-100)",
            schema: { type: "integer", default: 20, minimum: 1, maximum: 100 },
          },
          {
            name: "cursor",
            in: "query",
            description: "Pagination cursor (timestamp or trip ID)",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TripListResponse",
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/UnauthorizedError" },
          "403": { $ref: "#/components/responses/ForbiddenError" },
          "429": { $ref: "#/components/responses/RateLimitError" },
        },
      },
      post: {
        summary: "Create a new trip",
        description:
          "Creates a new trip draft. Supports idempotency via the `Idempotency-Key` header.",
        operationId: "createTrip",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            description: "Unique UUID to guarantee idempotency across retries",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateTripRequest",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Trip created successfully",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TripResponse",
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequestError" },
          "401": { $ref: "#/components/responses/UnauthorizedError" },
          "403": { $ref: "#/components/responses/ForbiddenError" },
        },
      },
    },
    "/trips/{id}": {
      get: {
        summary: "Get trip details",
        description: "Returns details of a trip if user is authorized.",
        operationId: "getTripById",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Trip details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TripResponse" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFoundError" },
        },
      },
    },
    "/expenses": {
      get: {
        summary: "List expenses",
        description: "Returns paginated expenses for permitted trips.",
        operationId: "listExpenses",
        parameters: [
          {
            name: "trip_id",
            in: "query",
            description: "Filter expenses by trip ID",
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Paginated expense list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExpenseListResponse" },
              },
            },
          },
        },
      },
      post: {
        summary: "Create an expense",
        description: "Adds an expense to a trip.",
        operationId: "createExpense",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateExpenseRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Expense created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExpenseResponse" },
              },
            },
          },
        },
      },
    },
    "/settlements": {
      get: {
        summary: "Query settlements",
        description: "Lists settlement transactions, proofs, and status.",
        operationId: "listSettlements",
        parameters: [
          {
            name: "trip_id",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "expense_id",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Settlements list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SettlementListResponse" },
              },
            },
          },
        },
      },
    },
    "/webhooks": {
      get: {
        summary: "List registered webhooks",
        description: "Returns webhooks configured by the authenticated wallet.",
        operationId: "listWebhooks",
        responses: {
          "200": {
            description: "Webhooks list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookListResponse" },
              },
            },
          },
        },
      },
      post: {
        summary: "Register a webhook endpoint",
        description:
          "Registers a new webhook URL. Returns the secret key for HMAC-SHA256 signature verification.",
        operationId: "registerWebhook",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RegisterWebhookRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Webhook registered",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookEndpointResponse" },
              },
            },
          },
        },
      },
    },
    "/webhooks/{id}": {
      delete: {
        summary: "Delete a webhook endpoint",
        operationId: "deleteWebhook",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Webhook deleted successfully" },
          "404": { $ref: "#/components/responses/NotFoundError" },
        },
      },
    },
    "/webhooks/test": {
      post: {
        summary: "Dispatch test webhook ping",
        description:
          "Triggers a mock `ping` event to the specified webhook endpoint to verify connectivity.",
        operationId: "testWebhook",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  webhook_id: { type: "string" },
                },
                required: ["webhook_id"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Test delivery result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookDeliveryLog" },
              },
            },
          },
        },
      },
    },
    "/webhooks/deliveries": {
      get: {
        summary: "List webhook delivery logs",
        description: "Returns recent delivery attempts, status codes, and latency.",
        operationId: "listDeliveries",
        responses: {
          "200": {
            description: "Delivery logs list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeliveryLogsResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "stk_live_*",
        description:
          "Scoped API token issued via the Developer Platform console or `/api/v1/tokens`.",
      },
    },
    schemas: {
      CreateTripRequest: {
        type: "object",
        required: ["name", "members"],
        properties: {
          name: { type: "string", example: "Berlin Hackathon 2026" },
          description: { type: "string", example: "Team travel and booth expenses" },
          starts_on: { type: "string", format: "date", example: "2026-11-01" },
          ends_on: { type: "string", format: "date", example: "2026-11-07" },
          members: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", example: "Alex" },
                wallet_address: {
                  type: "string",
                  example: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVW5S",
                },
              },
            },
          },
        },
      },
      TripResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string" },
          starts_on: { type: "string" },
          ends_on: { type: "string" },
          members: { type: "array", items: { type: "object" } },
          created_by_wallet: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      TripListResponse: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/TripResponse" } },
          pagination: {
            type: "object",
            properties: {
              limit: { type: "integer" },
              cursor: { type: "string", nullable: true },
              has_more: { type: "boolean" },
            },
          },
        },
      },
      CreateExpenseRequest: {
        type: "object",
        required: ["trip_id", "title", "total_amount", "currency", "split_mode"],
        properties: {
          trip_id: { type: "string" },
          title: { type: "string", example: "Flight to Berlin" },
          total_amount: { type: "string", example: "450.0000000" },
          currency: { type: "string", example: "EUR" },
          split_mode: { type: "string", enum: ["equal", "custom"] },
        },
      },
      ExpenseResponse: {
        type: "object",
        properties: {
          id: { type: "string" },
          trip_id: { type: "string" },
          title: { type: "string" },
          total_amount: { type: "string" },
          currency: { type: "string" },
          settled: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      ExpenseListResponse: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/ExpenseResponse" } },
          pagination: { type: "object" },
        },
      },
      SettlementListResponse: {
        type: "object",
        properties: {
          data: { type: "array", items: { type: "object" } },
        },
      },
      RegisterWebhookRequest: {
        type: "object",
        required: ["url", "events"],
        properties: {
          url: { type: "string", format: "uri", example: "https://accounting.example.com/webhooks" },
          events: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "trip.created",
                "trip.updated",
                "expense.created",
                "expense.updated",
                "settlement.completed",
                "ping",
              ],
            },
          },
          description: { type: "string", example: "QuickBooks Live Sync" },
        },
      },
      WebhookEndpointResponse: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          secret: { type: "string", example: "whsec_..." },
          events: { type: "array", items: { type: "string" } },
          active: { type: "boolean" },
          created_at: { type: "string" },
        },
      },
      WebhookListResponse: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/WebhookEndpointResponse" } },
        },
      },
      WebhookDeliveryLog: {
        type: "object",
        properties: {
          id: { type: "string" },
          webhook_id: { type: "string" },
          event: { type: "string" },
          status_code: { type: "integer", nullable: true },
          latency_ms: { type: "integer" },
          success: { type: "boolean" },
          error: { type: "string", nullable: true },
          timestamp: { type: "string" },
          signature: { type: "string" },
        },
      },
      DeliveryLogsResponse: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/WebhookDeliveryLog" } },
        },
      },
    },
    responses: {
      BadRequestError: {
        description: "Bad Request - Invalid payload or parameters",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: {
                  type: "object",
                  properties: {
                    code: { type: "string" },
                    message: { type: "string" },
                    status: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      UnauthorizedError: {
        description: "Unauthorized - Missing or invalid Bearer token",
      },
      ForbiddenError: {
        description: "Forbidden - Token lacks necessary scope",
      },
      NotFoundError: {
        description: "Not Found - Requested resource does not exist",
      },
      RateLimitError: {
        description: "Too Many Requests - Rate limit exceeded",
      },
    },
  },
} as const;

/**
 * Sandbox accounting mappings for developers building ERP/accounting integrations.
 */
export const ACCOUNTING_SANDBOX_MAPPINGS = {
  quickbooks: {
    description: "Map StellarStar expense splits into QuickBooks Journal Entries",
    example: {
      SyncToken: "1",
      DocNumber: "SS-EXP-202610",
      TxnDate: "2026-10-20",
      Line: [
        {
          Description: "Team Travel Expense",
          Amount: 120.0,
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { name: "Travel & Entertainment" },
          },
        },
        {
          Description: "Settlement via Stellar Network (XLM)",
          Amount: 120.0,
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { name: "Stellar Clearing Account" },
          },
        },
      ],
    },
  },
  xero: {
    description: "Map StellarStar expenses into Xero Bill LineItems",
    example: {
      Type: "ACCPAY",
      Contact: { Name: "Stellar Travel Group" },
      Date: "2026-10-20",
      DueDate: "2026-10-27",
      LineAmountTypes: "Exclusive",
      LineItems: [
        {
          Description: "Team Dinner & Lodging",
          Quantity: 1,
          UnitAmount: 120.0,
          AccountCode: "420",
        },
      ],
    },
  },
};
