# Engineo Security & Trust Architecture

Security is a product capability in Engineo. Project schedules, costs, contracts, resource plans, and progress data can be commercially sensitive, so confidentiality and integrity are part of the product's correctness bar.

A customer VPN or private network is useful transport isolation, but it never replaces authentication, authorization, encryption, or auditability.

## Trust principles

1. **Never trust network location alone.** Requests are authenticated and authorized even on private networks.
2. **Least privilege by default.** Users, services, CI jobs, database roles, and integrations get only required access.
3. **Tenant boundaries are security boundaries.** Cross-tenant access must be structurally difficult and continuously tested.
4. **Encrypt in transit and at rest.**
5. **Secrets are not configuration files.** Production secrets belong in a secrets manager/KMS.
6. **Material actions are auditable.**
7. **AI has no privileged side door.** AI tools execute under the requesting user's authorization.
8. **Authoritative project state remains deterministic.** AI suggestions are proposals/scenarios until validated and applied.
9. **Customer-controlled networking is supported.** Engineo works behind standard VPNs, proxies, gateways, and private networks. Engineo is not a consumer VPN service.
10. **Secure failure beats silent fallback.**

## Security boundaries

```text
Internet / customer network
          |
          v
 TLS edge / WAF / customer gateway
          |
          v
     Engineo Web
          |
          v
      Engineo API
       |   |   |
       |   |   +--> approved outbound integrations
       |   +------> PostgreSQL
       +----------> deterministic engine
                         |
                         X no direct internet access required

AI orchestrator
   |
   +--> authorization-aware project tools
   +--> read/query tools
   +--> isolated scenarios
   +--> deterministic validators
   |
   X no direct database credentials
   X no permission bypass
```

The deterministic scheduling engine should not require internet access. This reduces attack surface and makes private/offline deployment easier.

## Identity and authorization

Foundation:
- secure browser sessions using HttpOnly, Secure, SameSite cookies;
- CSRF protection where cookie-authenticated state changes apply;
- server-side authorization on every protected operation;
- organization/project-scoped RBAC;
- explicit privileged/admin roles;
- session revocation and security-event logging;
- MFA support, mandatory for high-privilege SaaS accounts.

Enterprise:
- OIDC federation;
- SAML where customer requirements demand it;
- SCIM provisioning/deprovisioning;
- optional attribute/policy rules layered over RBAC;
- scoped service accounts with rotation;
- mTLS for selected machine-to-machine integrations.

Authorization belongs in the API/domain layer, never only in the UI.

## Tenant isolation

Every tenant-owned record must have an explicit organization ownership path.

Controls include:
- tenant context established from authenticated identity, never an untrusted request body alone;
- data-access APIs requiring tenant context;
- foreign-key/uniqueness strategies that preserve ownership;
- negative authorization tests attempting cross-tenant reads and writes;
- background jobs carrying validated tenant context;
- object-storage isolation equivalent to database isolation;
- cache keys including tenant identity;
- audit logs recording tenant and actor.

Database row-level security may be an additional layer, not a substitute for application authorization.

## Data protection

- TLS for all production client/server traffic.
- TLS for database/service links crossing process or host trust boundaries.
- encrypted disks, databases, backups, and object storage.
- KMS/envelope encryption for especially sensitive data where justified.
- key versioning and rotation.
- separate secrets from encryption keys.
- backup encryption and restore testing.
- explicit retention/deletion policies.

## Audit model

Security-sensitive and material project events should capture:

```text
event_id
occurred_at
tenant_id
actor_type
actor_id
session_or_service_identity
action
resource_type
resource_id
source
request_or_correlation_id
before_after_or_change_reference
result
security_metadata
```

Audit logs are append-oriented. Normal application users cannot rewrite history.

High-value events include login/session events, permission changes, membership changes, API credentials, imports/exports, baseline creation, bulk schedule changes, scenario application, AI-proposed/applied actions, network/security configuration, and data deletion.

## Customer VPN, proxy, and private-network support

### Client VPN compatibility

The Engineo web client uses HTTPS. If a customer's device routes HTTPS through its corporate VPN, secure web gateway, or zero-trust network, Engineo should work without special Engineo VPN code.

Document required hostnames/ports, realtime transport requirements, certificate interception considerations, DNS requirements, upload/download limits, and idle timeout expectations.

### Outbound HTTP/HTTPS proxy

Self-hosted/private deployments may require outbound integrations to pass through a customer proxy.

Support standard configuration semantics:

```text
HTTP_PROXY
HTTPS_PROXY
NO_PROXY
```

Requirements:
- proxy credentials are secret references, never normal logs or project exports;
- enterprise CA trust can be configured deliberately;
- NO_PROXY behavior is tested;
- outbound-capable subsystems use a shared egress-policy/client abstraction;
- direct egress can be disabled.

### SSRF boundary

Proxy support must never turn Engineo into an arbitrary network tunnel.

Outbound integrations must:
- use explicit destination allowlists/policies;
- reject unsafe URL schemes;
- resolve and validate destinations before connection;
- protect loopback, link-local, metadata-service, and private ranges unless explicitly permitted for a configured private integration;
- handle DNS rebinding safely;
- limit redirects;
- apply connection/read timeouts and size limits;
- never forward unrelated inbound headers or credentials.

### Private enterprise connectivity

Later options:
- IP allowlists at the edge;
- customer reverse proxies/WAFs;
- site-to-site VPN to a private Engineo deployment;
- cloud private endpoints/private connectivity;
- identity-aware zero-trust access gateways;
- mTLS for API/integration clients;
- self-hosted/private-cloud deployment;
- offline or tightly restricted egress mode.

These are deployment options. Authentication and authorization still apply inside the private network.

## API security

- schema validation at every trust boundary;
- parameterized database queries;
- strict content types and payload-size limits;
- rate limits and abuse controls;
- restrictive CORS;
- secure headers and CSP;
- short-lived scoped credentials;
- explicit pagination/export limits;
- idempotency for sensitive retryable operations;
- safe error responses without secrets or internal stack leakage.

## Import/export security

Scheduling products ingest complex files, making imports a major attack surface.

Importers must:
- treat files as hostile;
- enforce size, record, and nesting limits;
- avoid shelling out with user-controlled arguments;
- parse in constrained workers where practical;
- reject path traversal and archive bombs;
- avoid external entity/network resolution;
- validate normalized data before persistence;
- produce explicit diagnostics;
- record source, actor, file hash, and result.

Exporters must prevent unauthorized cross-project or cross-tenant data inclusion.

## AI security boundary

The AI layer receives no blanket database or infrastructure access.

Rules:
- every AI tool call carries authenticated tenant/user context;
- tools independently authorize each operation;
- read tools return only authorized fields;
- write tools create proposals/scenarios by default;
- deterministic engines validate material changes;
- applying a scenario requires permission and an auditable action;
- retrieved documents/imported text are untrusted prompt content;
- prompt injection cannot grant tools or permissions;
- secrets are never intentionally placed in model context;
- enterprise deployments can configure model/provider data handling.

## Supply-chain and CI security

Immediate:
- dependency vulnerability gates;
- explicit approval for dependency install/build scripts;
- lockfiles and reproducible installs;
- automated dependency updates;
- minimal GitHub Actions permissions;
- secret scanning and static analysis;
- protected main branch with required CI;
- review/pinning strategy for third-party GitHub Actions.

Later:
- SBOMs;
- signed release artifacts;
- provenance/attestations;
- container scanning;
- hardened non-root runtime images;
- production deployment approvals.

## Backup, recovery, and incident readiness

Before production customer data:
- encrypted automated backups;
- point-in-time recovery where supported;
- restore drills with measured RPO/RTO;
- separate backup credentials;
- incident severity model and runbooks;
- security contact/reporting process;
- credential/key rotation procedures;
- tenant notification workflow;
- security logs retained independently enough for investigation.

## Security verification

Security controls require tests, not promises:
- cross-tenant read/write denial;
- role/permission matrix;
- session fixation/revocation;
- invalid/expired token handling;
- CSRF/CORS/security headers;
- proxy and NO_PROXY behavior;
- SSRF destination/DNS-rebinding tests;
- malicious import corpus;
- rate limits;
- secret-leak scanning;
- backup restore;
- AI authorization and prompt-injection regression tests.

## Assurance direction

Design toward an OWASP-aligned secure development lifecycle, NIST-style zero-trust/logging principles, and controls that can later support SOC 2 and ISO 27001 assurance if commercial demand justifies it.

Certification is evidence layered on top of real controls, not the security architecture itself.
