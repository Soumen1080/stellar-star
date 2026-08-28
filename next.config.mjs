/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: process.cwd(),

  // ── Images ────────────────────────────────────────────────────────────────
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "stellar.expert" },
      { protocol: "https", hostname: "**.stellar.org" },
    ],
  },

  // ── Security scan build (scripts/verify-no-e2e-bypass.mjs) ────────────────
  // When STELLARSTAR_SECURITY_SCAN=1 we deliberately relax the build-time
  // type/lint gates so a production bundle can be emitted and scanned for the
  // E2E wallet seam. This flag is NEVER set in normal or production builds, so
  // those builds remain strict. The emitted client code is identical production
  // minified output; only the pre-flight checks are skipped.
  typescript: { ignoreBuildErrors: process.env.STELLARSTAR_SECURITY_SCAN === "1" },
  eslint: { ignoreDuringBuilds: process.env.STELLARSTAR_SECURITY_SCAN === "1" },

  // ── Production security headers ───────────────────────────────────────────
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },

  // ── Compiler options ──────────────────────────────────────────────────────
  compiler: {
    // Remove console.log in production
    removeConsole: process.env.NODE_ENV === "production"
      ? { exclude: ["error", "warn"] }
      : false,
  },

  // ── Optional: enable standalone output for Docker / self-hosting ─────────
  // output: "standalone",

  // ── E2E wallet seam: pin the build-time flag to a literal ───────────────
  // `process.env.NEXT_PUBLIC_E2E_TEST_MODE` is the only gate for the Playwright
  // wallet seam (lib/stellar/e2eWallet.ts). Next.js inlines DEFINED NEXT_PUBLIC_*
  // vars but leaves UNSET ones as a runtime `process.env` lookup, which keeps
  // the (inert) seam branch in the production bundle. Defining it explicitly —
  // as "true" only when the env is set, otherwise "false" — guarantees the guard
  // inlines to a literal in every build. In a normal production build (unset)
  // it folds to `if ("false" !== "true") return null;` and the
  // `window.__E2E_WALLET__` branch is dead-code-eliminated, so the seam does NOT
  // ship. A build created WITH the flag set keeps the seam (test artifact only).
  webpack: (config, { webpack }) => {
    config.plugins.push(
      new webpack.DefinePlugin({
        "process.env.NEXT_PUBLIC_E2E_TEST_MODE": JSON.stringify(
          process.env.NEXT_PUBLIC_E2E_TEST_MODE ?? "false",
        ),
      }),
    );
    return config;
  },
};

export default nextConfig;
