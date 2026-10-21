# Security Policy & Responsible Disclosure

Stellar Star takes the security of our users and smart contract systems seriously. We welcome security researchers to inspect our codebase and responsibly disclose any vulnerabilities.

## Reporting a Vulnerability

If you discover a security vulnerability in Stellar Star, please report it privately. **Do not create public GitHub issues or disclose findings publicly until they have been addressed.**

- **Email**: [security@stellarstar.app](mailto:security@stellarstar.app)
- **Security Contact**: Security Architecture & Operations Team
- **Encryption**: You may request our PGP public key via email before sending sensitive material.

Please include the following details in your report:
1. **Description**: Clear description of the vulnerability and attack vector.
2. **Impact**: Potential consequences if exploited (e.g., unauthorized funds movement, data exposure, denial of service).
3. **Reproduction Steps**: Step-by-step instructions, proof of concept, or minimal test case.
4. **Affected Components**: Contract, API route, database policy, or client UI.

## Response & Remediation Timelines (SLA)

We commit to the following response targets:
- **Initial Acknowledgment**: Within 24 hours of receipt.
- **Triage & Severity Assessment**: Within 72 hours.
- **Remediation Plan**:
  - **Critical / P0**: Fix committed within 48 hours of triage; emergency hotfix deployed immediately.
  - **High / P1**: Fix committed within 7 days.
  - **Medium / P2**: Fix scheduled for the next release cycle (within 30 days).
  - **Low / P3**: Tracked and prioritized in regular product backlog.
- **Disclosure**: Coordinated public disclosure after fixes have landed and users/nodes are updated.

## Scope

The following components are in scope for our security program:
- **Smart Contracts** (`contract/src/`): Soroban settlement and pool contracts.
- **API Routes & Webhooks** (`app/api/`): Challenge/response authentication, attestation oracle, reconciliation, invitations, exports.
- **Database & Row Level Security** (`supabase-setup.sql`, `migrations/`): PostgREST RLS policies, PostgreSQL stored procedures, and triggers.
- **Client Application & Wallets** (`lib/stellar/`, `components/`): Wallet integration, transaction construction, and network configuration guards.

### Out of Scope
- Denial-of-service attacks against third-party public Stellar Horizon or Soroban RPC nodes.
- Social engineering attacks targeting community contributors or maintainers.
- Compromises arising from malware or compromised browser extensions on the client's own device (beyond hostile client mitigations documented in [THREAT_MODEL.md](docs/THREAT_MODEL.md)).

## Safe Harbor

We consider security research conducted under this policy to be authorized. We will not pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations, data destruction, and service interruption.
- Give us reasonable time to remediate before making any public disclosure.
- Do not exploit a vulnerability beyond the minimal evidence needed to demonstrate impact.
