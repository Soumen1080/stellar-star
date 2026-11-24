# Wallet capabilities and fallbacks (#330)

The connection picker detects installation, address access, transaction
signing, network reporting, and the ability to sign path-payment XDR for the
selected adapter. The app does not infer a network when an adapter cannot
report one. Before each signing prompt it reads the selected adapter's active
address and network again and compares them with the intended signer and app
network.

If a wallet is absent, cannot sign, reports a different address, or cannot
verify the network, the app stops before the signature dialog. When possible,
the unsigned transaction XDR is copied for import into a compatible wallet;
the connect picker links to supported wallet install pages. No signature or
submission is performed by the fallback.

## Adapter test matrix

| Mode | Address | Sign XDR | Network detection | Path-payment XDR | Fallback |
|---|---:|---:|---:|---:|---|
| Freighter | Detect live | Detect live | Detect live | Same transaction signer | Install link / copy XDR |
| xBull | Detect API methods | Detect API methods | Detect `getNetwork`; unknown blocks sign | Same transaction signer | Install link / copy XDR |
| Lobstr | Detect API methods | Detect API methods | Detect `getNetwork`; unknown blocks sign | Same transaction signer | Install link / copy XDR |
| No wallet | No | No | No | No | Install link / copy XDR |

Automated coverage is in `__tests__/freighter/capabilities.test.ts` and
`__tests__/freighter/index.test.ts`. Wallet extension APIs can change; the
runtime checks are authoritative for the installed extension session.
