"use client";

import React from "react";
import { getNetworkConfigErrors } from "@/lib/utils/constants";

/**
 * Startup guard for network configuration.
 *
 * Invariant 1: the app must be internally consistent by construction, or refuse
 * to start with a specific, actionable message. Derivation in `constants.ts`
 * makes the common case consistent for free; this component catches the
 * explicit-but-wrong case (e.g. `STELLAR_NETWORK=PUBLIC` with a testnet
 * `HORIZON_URL`) and, instead of letting the user sign against mismatched
 * infrastructure, renders a full-screen diagnostic. It is evaluated on the
 * client so the build can still complete while the running app refuses to run.
 */
export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const errors = getNetworkConfigErrors();

  if (errors.length > 0) {
    return (
      <ConfigErrorScreen errors={errors} />
    );
  }

  return <>{children}</>;
}

function ConfigErrorScreen({ errors }: { errors: string[] }) {
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#0F0F14",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        overflow: "auto",
      }}
    >
      <div style={{ maxWidth: 640, width: "100%" }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>
          Stellar-star cannot start: network configuration is unsafe
        </h1>
        <p style={{ color: "#aaa", marginBottom: 20, fontSize: 14 }}>
          The app was asked to run against an inconsistent set of Stellar
          networks. This is blocked on purpose — continuing would risk signing
          transactions against the wrong infrastructure. Fix the environment
          variables below and restart.
        </p>
        <ul
          style={{
            background: "#1a1a24",
            border: "1px solid #2DD4BF33",
            borderRadius: 12,
            padding: "16px 20px",
            margin: 0,
            listStyle: "none",
          }}
        >
          {errors.map((err, i) => (
            <li
              key={i}
              style={{
                color: "#ffb4b4",
                fontSize: 13,
                lineHeight: 1.5,
                padding: "6px 0",
                borderBottom:
                  i < errors.length - 1 ? "1px solid #ffffff14" : "none",
              }}
            >
              {err}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
