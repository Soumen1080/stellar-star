#!/usr/bin/env bash
set -euo pipefail

quota_wallet="G_QUOTA_CONCURRENCY"
parallel_calls=30
expected_allowed=5
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-stellar_star_test}" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.tenant_quota_limits (wallet_address, requests_per_minute) VALUES ('$quota_wallet', $expected_allowed) ON CONFLICT (wallet_address) DO UPDATE SET requests_per_minute = EXCLUDED.requests_per_minute; DELETE FROM public.tenant_quota_usage WHERE wallet_address = '$quota_wallet';" >/dev/null

for index in $(seq 1 "$parallel_calls"); do
  (
    psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-stellar_star_test}" -Atq -v ON_ERROR_STOP=1 \
      -c "SET ROLE service_role; SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false); SELECT (public.consume_tenant_quotas('$quota_wallet', 0, 0, 0, 0, 1) ->> 'allowed')::boolean;" \
      | tail -n 1 > "$temp_dir/$index"
  ) &
done
wait

allowed="$(awk '$0 == "t" { count++ } END { print count + 0 }' "$temp_dir"/*)"
if [[ "$allowed" -ne "$expected_allowed" ]]; then
  echo "Expected exactly $expected_allowed of $parallel_calls concurrent reservations; observed $allowed." >&2
  exit 1
fi
echo "Concurrent quota check passed: $allowed/$parallel_calls reservations allowed."
