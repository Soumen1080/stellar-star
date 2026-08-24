#!/usr/bin/env node
/**
 * End-to-end check of the Supabase setup.
 *
 *   npm run db:check
 *
 * Verifies, in order:
 *   1. the env vars are present and well-formed
 *   2. SUPABASE_JWT_SECRET really is this project's signing key
 *   3. the tables from supabase-setup.sql exist
 *   4. a minted wallet JWT is accepted, and RLS scopes rows to that wallet
 *   5. the full sign-up write path works (insert a profile, read it back)
 *
 * Everything it creates is removed again before it exits.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");

// ─── Output helpers ───────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let failures = 0;
let warnings = 0;

const pass = (msg, detail) =>
  console.log(`${GREEN}  PASS${RESET}  ${msg}${detail ? `\n${DIM}        ${detail}${RESET}` : ""}`);
const fail = (msg, detail) => {
  failures += 1;
  console.log(`${RED}  FAIL${RESET}  ${msg}${detail ? `\n${DIM}        ${detail}${RESET}` : ""}`);
};
const warn = (msg, detail) => {
  warnings += 1;
  console.log(`${YELLOW}  WARN${RESET}  ${msg}${detail ? `\n${DIM}        ${detail}${RESET}` : ""}`);
};
const section = (title) => console.log(`\n${BOLD}${title}${RESET}`);

// ─── Env loading ──────────────────────────────────────────────────────────────

/** Reads .env files the way Next.js does: .env.local wins over .env. */
function loadEnv() {
  const env = {};
  for (const file of [".env", ".env.local"]) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) continue;

    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  }
  return { ...env, ...process.env };
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function mintWalletToken(secret, wallet, ttlSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "supabase",
      aud: "authenticated",
      role: "authenticated",
      sub: wallet,
      wallet_address: wallet,
      iat: now,
      exp: now + ttlSeconds,
    })
  );
  const signature = b64url(
    crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

function verifyJwtSignature(token, secret) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const expected = b64url(
    crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );
  return expected === signature;
}

// ─── REST helpers ─────────────────────────────────────────────────────────────

function makeRest(url, anonKey) {
  return async function rest(pathname, { method = "GET", token, body, prefer } = {}) {
    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${token ?? anonKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const res = await fetch(`${url}/rest/v1/${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, ok: res.ok, body: json };
  };
}

const SETUP_HINT =
  "Run supabase-setup.sql in the Supabase Dashboard -> SQL Editor, then re-run this check.";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}Stellar-star — Supabase connection check${RESET}`);

  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const jwtSecret = (env.SUPABASE_JWT_SECRET || env.JWT_SECRET)?.trim();

  // 1. Environment ───────────────────────────────────────────────────────────
  section("1. Environment");

  if (!url) fail("NEXT_PUBLIC_SUPABASE_URL is not set");
  else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)$/i.test(url))
    warn("NEXT_PUBLIC_SUPABASE_URL does not look like a Supabase project URL", url);
  else pass("NEXT_PUBLIC_SUPABASE_URL", url);

  if (!anonKey) fail("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  else pass("NEXT_PUBLIC_SUPABASE_ANON_KEY", `${anonKey.slice(0, 12)}… (${anonKey.length} chars)`);

  if (!jwtSecret) fail("SUPABASE_JWT_SECRET is not set", "Dashboard -> Project Settings -> API -> JWT Settings");
  else pass("SUPABASE_JWT_SECRET", `set (${jwtSecret.length} chars)`);

  if (!url || !anonKey || !jwtSecret) {
    console.log(`\n${RED}Cannot continue without the three variables above.${RESET}`);
    process.exit(1);
  }

  // 2. Secret / key agreement ────────────────────────────────────────────────
  section("2. JWT secret matches the project");

  if (anonKey.split(".").length === 3) {
    if (verifyJwtSignature(anonKey, jwtSecret)) {
      pass("SUPABASE_JWT_SECRET signs this project's anon key", "tokens minted by /api/auth/verify will be accepted");
    } else {
      fail(
        "SUPABASE_JWT_SECRET does not match NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "Every wallet session would be rejected. Copy the JWT secret from Project Settings -> API."
      );
    }
  } else {
    warn(
      "The anon key is not a legacy JWT, so the secret cannot be cross-checked here",
      "This project may use the new publishable/secret key format, which needs a different auth strategy."
    );
  }

  const rest = makeRest(url, anonKey);

  // 3. Schema ────────────────────────────────────────────────────────────────
  section("3. Tables");

  const tables = ["users", "expenses", "trips"];
  let schemaMissing = false;

  for (const table of tables) {
    const res = await rest(`${table}?select=*&limit=1`);
    if (res.ok) {
      pass(`public.${table} exists and is reachable`);
    } else if (res.body?.code === "PGRST205") {
      schemaMissing = true;
      fail(`public.${table} does not exist`, SETUP_HINT);
    } else {
      fail(`public.${table} returned ${res.status}`, JSON.stringify(res.body));
    }
  }

  if (schemaMissing) {
    console.log(`\n${RED}Schema is not installed — skipping the remaining checks.${RESET}`);
    console.log(`${DIM}${SETUP_HINT}${RESET}`);
    process.exit(1);
  }

  // 4. RLS ───────────────────────────────────────────────────────────────────
  section("4. Row Level Security");

  const walletA = `GTEST${crypto.randomBytes(20).toString("hex").toUpperCase()}`.slice(0, 56);
  const walletB = `GTEST${crypto.randomBytes(20).toString("hex").toUpperCase()}`.slice(0, 56);
  const tokenA = mintWalletToken(jwtSecret, walletA);
  const tokenB = mintWalletToken(jwtSecret, walletB);

  const anonTrips = await rest("trips?select=id&limit=1");
  if (anonTrips.ok && Array.isArray(anonTrips.body) && anonTrips.body.length === 0) {
    pass("An unauthenticated request sees no trips", "RLS is filtering, not just permitting");
  } else if (anonTrips.ok) {
    fail("An unauthenticated request returned trip rows", "The SELECT policy on trips is too permissive.");
  } else {
    warn(`Anonymous read of trips returned ${anonTrips.status}`, JSON.stringify(anonTrips.body));
  }

  // 5. Write path ────────────────────────────────────────────────────────────
  section("5. Sign-up write path");

  const createdUsers = [];
  const createdTrips = [];

  const insertUser = await rest("users", {
    method: "POST",
    token: tokenA,
    prefer: "return=representation",
    body: { wallet_address: walletA, display_name: "Connection Check" },
  });

  if (insertUser.ok && Array.isArray(insertUser.body) && insertUser.body[0]) {
    createdUsers.push(insertUser.body[0].id);
    pass("A wallet JWT can create its own profile", `id ${insertUser.body[0].id}`);
  } else {
    fail(
      `Creating a profile failed with ${insertUser.status}`,
      `${JSON.stringify(insertUser.body)}\n        This is the error users hit during sign-up.`
    );
  }

  const spoof = await rest("users", {
    method: "POST",
    token: tokenA,
    prefer: "return=representation",
    body: { wallet_address: walletB, display_name: "Impersonation Attempt" },
  });

  if (spoof.ok) {
    if (Array.isArray(spoof.body) && spoof.body[0]) createdUsers.push(spoof.body[0].id);
    fail("Wallet A created a profile for wallet B", "The users INSERT policy is not checking the JWT claim.");
  } else {
    pass("A wallet cannot create a profile for a different wallet", `rejected with ${spoof.status}`);
  }

  const readBack = await rest(`users?select=*&wallet_address=eq.${walletA}`, { token: tokenA });
  if (readBack.ok && Array.isArray(readBack.body) && readBack.body.length === 1) {
    pass("The new profile reads back immediately", `display_name "${readBack.body[0].display_name}"`);
  } else {
    fail("Could not read the profile back after creating it", JSON.stringify(readBack.body));
  }

  // 6. Trip round trip + trigger behaviour ───────────────────────────────────
  section("6. Trips, RLS scoping and triggers");

  const insertTrip = await rest("trips", {
    method: "POST",
    token: tokenA,
    prefer: "return=representation",
    body: {
      name: "Connection Check Trip",
      members: [
        { id: "m1", name: "A", walletAddress: walletA },
        { id: "m2", name: "B", walletAddress: walletB },
      ],
      created_by_wallet: walletA,
    },
  });

  if (insertTrip.ok && Array.isArray(insertTrip.body) && insertTrip.body[0]) {
    const trip = insertTrip.body[0];
    createdTrips.push(trip.id);
    pass("A wallet JWT can create a trip", `id ${trip.id}`);

    const wallets = trip.member_wallets ?? [];
    if (wallets.includes(walletA) && wallets.includes(walletB)) {
      pass("member_wallets was derived from members by the database trigger", `${wallets.length} wallets`);
    } else {
      fail(
        "member_wallets was not derived correctly",
        `got ${JSON.stringify(wallets)} — the sync_member_wallets trigger is missing. Re-run supabase-setup.sql.`
      );
    }

    const asB = await rest(`trips?select=id&id=eq.${trip.id}`, { token: tokenB });
    if (asB.ok && Array.isArray(asB.body) && asB.body.length === 1) {
      pass("A listed member can read the shared trip");
    } else {
      fail("A listed member could not read the shared trip", JSON.stringify(asB.body));
    }

    const stranger = mintWalletToken(jwtSecret, `GSTRANGER${"X".repeat(46)}`.slice(0, 56));
    const asStranger = await rest(`trips?select=id&id=eq.${trip.id}`, { token: stranger });
    if (asStranger.ok && Array.isArray(asStranger.body) && asStranger.body.length === 0) {
      pass("A non-member cannot read the trip");
    } else {
      fail("A non-member could read the trip", JSON.stringify(asStranger.body));
    }

    // A member may edit, but must not become the owner.
    const takeover = await rest(`trips?id=eq.${trip.id}`, {
      method: "PATCH",
      token: tokenB,
      prefer: "return=representation",
      body: { name: "Renamed by member B", created_by_wallet: walletB },
    });

    if (takeover.ok && Array.isArray(takeover.body) && takeover.body[0]) {
      const owner = takeover.body[0].created_by_wallet;
      if (owner === walletA) {
        pass("A member can edit the trip without taking ownership", "created_by_wallet stayed with the creator");
      } else {
        fail("A member took ownership of the trip", "The freeze_row_identity trigger is missing. Re-run supabase-setup.sql.");
      }
    } else {
      warn(`A member could not edit the trip (${takeover.status})`, JSON.stringify(takeover.body));
    }

    const wrongDelete = await rest(`trips?id=eq.${trip.id}`, {
      method: "DELETE",
      token: tokenB,
      prefer: "return=representation",
    });
    if (wrongDelete.ok && Array.isArray(wrongDelete.body) && wrongDelete.body.length === 0) {
      pass("A non-creator cannot delete the trip");
    } else if (!wrongDelete.ok) {
      pass("A non-creator cannot delete the trip", `rejected with ${wrongDelete.status}`);
    } else {
      fail("A non-creator deleted the trip", "The DELETE policy on trips is too permissive.");
      createdTrips.length = 0;
    }
  } else {
    fail(`Creating a trip failed with ${insertTrip.status}`, JSON.stringify(insertTrip.body));
  }

  // 7. Realtime ──────────────────────────────────────────────────────────────
  section("7. Realtime");

  const realtimeRes = await fetch(
    `${url}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`,
    { headers: { Connection: "Upgrade", Upgrade: "websocket" } }
  ).catch((err) => ({ status: 0, err }));

  if (realtimeRes.status === 426 || realtimeRes.status === 101 || realtimeRes.status === 400) {
    pass("The Realtime endpoint is reachable", `handshake responded ${realtimeRes.status}`);
  } else {
    warn(
      `Realtime endpoint returned ${realtimeRes.status ?? "no response"}`,
      "Live updates may not work; confirm Realtime is enabled for this project."
    );
  }

  // 8. Cleanup ───────────────────────────────────────────────────────────────
  section("8. Cleanup");

  for (const id of createdTrips) {
    const res = await rest(`trips?id=eq.${id}`, { method: "DELETE", token: tokenA });
    if (res.ok) pass(`Removed test trip ${id}`);
    else warn(`Could not remove test trip ${id}`, JSON.stringify(res.body));
  }
  for (const id of createdUsers) {
    const owner = id === createdUsers[0] ? tokenA : tokenA;
    const res = await rest(`users?id=eq.${id}`, { method: "DELETE", token: owner });
    if (res.ok) pass(`Removed test profile ${id}`);
    else warn(`Could not remove test profile ${id}`, `${JSON.stringify(res.body)} — delete it by hand.`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("");
  if (failures === 0) {
    console.log(`${GREEN}${BOLD}All checks passed${RESET}${warnings ? ` ${YELLOW}(${warnings} warning${warnings === 1 ? "" : "s"})${RESET}` : ""}`);
    console.log(`${DIM}Sign-up, RLS scoping and the trip round trip all work against this project.${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${failures} check${failures === 1 ? "" : "s"} failed${RESET}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n${RED}The check crashed:${RESET}`, err);
  process.exit(1);
});
