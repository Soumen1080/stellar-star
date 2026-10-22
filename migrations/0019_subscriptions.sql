CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, renewal_cadence TEXT NOT NULL,
  next_renewal_at TIMESTAMP NOT NULL, owner_id TEXT NOT NULL, share_rule TEXT NOT NULL,
  expected_amount NUMERIC NOT NULL, currency TEXT NOT NULL, cancellation_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscription_price_history (
  id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL, currency TEXT NOT NULL, effective_at TIMESTAMP NOT NULL, recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS subscriptions_renewal_idx ON subscriptions(next_renewal_at);
