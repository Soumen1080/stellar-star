import {
  registerWebhookEndpoint,
  listWebhooksForWallet,
  deleteWebhookEndpoint,
  signWebhookPayload,
  verifyWebhookSignature,
  sendTestWebhookPing,
  clearWebhookStore,
} from "@/lib/api/webhooks";

describe("Developer Webhooks Framework", () => {
  const testWallet = "G_WEBHOOK_DEVELOPER_123456789012345678901234567890";
  const validUrl = "https://accounting.example.com/api/stellar-webhook";

  beforeEach(() => {
    clearWebhookStore();
  });

  it("registers a webhook endpoint with generated HMAC secret", () => {
    const webhook = registerWebhookEndpoint({
      walletAddress: testWallet,
      url: validUrl,
      events: ["trip.created", "expense.created"],
      description: "ERP Connector",
    });

    expect(webhook.id).toBeTruthy();
    expect(webhook.secret).toMatch(/^whsec_/);
    expect(webhook.events).toEqual(["trip.created", "expense.created"]);
    expect(webhook.walletAddress).toBe(testWallet);

    const list = listWebhooksForWallet(testWallet);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(webhook.id);
  });

  it("rejects non-HTTPS webhook URLs in production mode", () => {
    expect(() =>
      registerWebhookEndpoint({
        walletAddress: testWallet,
        url: "http://insecure-server.com/hook",
        events: ["trip.created"],
      })
    ).toThrow(/must use https/i);
  });

  it("signs and verifies webhook payload with timestamp and HMAC-SHA256", () => {
    const secret = "whsec_supersecretkey123456789";
    const payload = JSON.stringify({ event: "trip.created", trip_id: "trip-1" });
    const signatureHeader = signWebhookPayload(payload, secret);

    expect(signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const verified = verifyWebhookSignature(payload, signatureHeader, secret);
    expect(verified.valid).toBe(true);
  });

  it("rejects payloads that exceed the replay protection tolerance window", () => {
    const secret = "whsec_supersecretkey123456789";
    const payload = JSON.stringify({ event: "trip.created" });
    // Signed 10 minutes ago
    const pastTimestamp = Math.floor(Date.now() / 1000) - 600;
    const staleSignature = signWebhookPayload(payload, secret, pastTimestamp);

    const verified = verifyWebhookSignature(payload, staleSignature, secret, 300);
    expect(verified.valid).toBe(false);
    expect(verified.error).toMatch(/tolerance window/i);
  });

  it("executes a test webhook ping and logs delivery telemetry", async () => {
    const webhook = registerWebhookEndpoint({
      walletAddress: testWallet,
      url: "https://httpbin.org/post",
      events: ["ping"],
    });

    // Mock global fetch for the test ping
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as any);

    const log = await sendTestWebhookPing(webhook.id, testWallet);
    expect(log).toBeDefined();
    expect(log.event).toBe("ping");
    expect(log.statusCode).toBe(200);
    expect(log.success).toBe(true);
    expect(log.signature).toMatch(/^t=\d+,v1=/);
  });
});
