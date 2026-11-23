/** Server-only typed allowlist. Keep imports out of client components. */
if (typeof window !== "undefined") throw new Error("serverEnv cannot run in a browser.");

export const serverEnv = {
  nodeEnv: process.env.NODE_ENV,
  jwtActiveKeyId: process.env.JWT_ACTIVE_KEY_ID,
  jwtSigningKeys: process.env.JWT_SIGNING_KEYS,
  jwtPreviousKeysUntil: process.env.JWT_PREVIOUS_KEYS_UNTIL,
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
  jwtSecret: process.env.JWT_SECRET,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  apiSigningSecret: process.env.API_SIGNING_SECRET,
  exportAuditIpSalt: process.env.EXPORT_AUDIT_IP_SALT,
  cronSecret: process.env.CRON_SECRET,
  errorReportingWebhook: process.env.ERROR_REPORTING_WEBHOOK,
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
  exchangeRateApiKey: process.env.EXCHANGERATE_API_KEY,
  coingeckoApiKey: process.env.COINGECKO_API_KEY,
  settlementOracleSecret: process.env.SETTLEMENT_ORACLE_SECRET,
  settlementOracleSigners: process.env.SETTLEMENT_ORACLE_SIGNERS,
  settlementOracleThreshold: process.env.SETTLEMENT_ORACLE_THRESHOLD,
  sponsorOperatorSecret: process.env.SPONSOR_OPERATOR_SECRET,
  reminderEmailWebhookUrl: process.env.REMINDER_EMAIL_WEBHOOK_URL,
  reminderPushWebhookUrl: process.env.REMINDER_PUSH_WEBHOOK_URL,
  reminderWebhookSecret: process.env.REMINDER_WEBHOOK_SECRET,
  reminderUnsubscribeSecret: process.env.REMINDER_UNSUBSCRIBE_SECRET,
  maxSponsorshipsPerInviter: process.env.MAX_SPONSORSHIPS_PER_INVITER,
  inviteCooldownMs: process.env.INVITE_COOLDOWN_MS,
  inviterMinSpendableStroops: process.env.INVITER_MIN_SPENDABLE_STROOPS,
  sponsorshipCapStroops: process.env.SPONSORSHIP_CAP_STROOPS,
  stellarCustomAssets: process.env.STELLAR_CUSTOM_ASSETS,
} as const;

export type ServerEnv = typeof serverEnv;
