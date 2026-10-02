# Engineo Threat Model

Status: living document.

## Protected assets

Highest-value assets include:
- project schedules, logic, baselines, forecasts, costs, and progress;
- organization/project membership and permissions;
- audit history;
- imported customer files and exports;
- integration credentials and API tokens;
- encryption/signing keys;
- backups;
- AI tool permissions and model context;
- build/release credentials.

## Required security properties

### Confidentiality
A user can access only the organizations, projects, fields, files, and exports they are authorized to access.

### Integrity
Unauthorized actors cannot change authoritative project state, scheduling inputs, baselines, costs, permissions, calculated results, or audit history.

### Availability
Customers can reach project data and deterministic calculation services within defined objectives and recover from destructive failures.

### Accountability
Material actions can be traced to an authenticated actor/service and correlation context.

## Trust boundaries

1. Browser to Engineo edge.
2. Edge to application services.
3. API to database/object storage.
4. API to deterministic engine.
5. API/workers to third-party integrations.
6. Application to identity provider/KMS.
7. AI orchestrator to Engineo tools.
8. CI/CD to release artifacts and deployment.
9. Tenant A to Tenant B.
10. Customer private network/proxy to Engineo.

## Primary threat classes

### Identity compromise
Stolen sessions, weak MFA, token theft, federation mistakes, and orphaned enterprise users.

Controls: MFA, short-lived sessions/tokens, revocation, secure cookies, strict federation validation, deprovisioning, and security-event logging.

### Broken access control
IDOR/BOLA, privilege escalation, cross-tenant access, and background-job tenant confusion.

Controls: server-side authorization, tenant-scoped repositories, negative authorization tests, and explicit actor/tenant context.

### Project-state tampering
Unauthorized edits to schedule logic, costs, baselines, or calculated results.

Controls: authorization, immutable baseline semantics, deterministic engine, audit history, and scenario-before-apply workflows.

### Injection and unsafe parsing
SQL injection, XSS, command injection, malicious imports, archive bombs, and parser abuse.

Controls: parameterization, output encoding/CSP, no shell interpolation, bounded parsers, and hostile-file fixtures.

### SSRF and egress abuse
Integrations, webhooks, proxy settings, or AI tools used to access metadata services or internal networks.

Controls: central egress policy, allowlists, IP/range checks, redirect controls, DNS-rebinding defenses, and time/size limits.

### Secret/key compromise
Credentials leaked in code, logs, exports, CI, backups, or AI context.

Controls: secret scanning, KMS/secrets manager, redaction, scoped credentials, rotation, and no secret export/model context.

### Supply-chain compromise
Malicious dependencies, install scripts, CI actions, or a compromised release pipeline.

Controls: lockfiles, vulnerability gates, explicit build-script allowlists, minimal workflow permissions, action review/pinning, and future provenance/signing.

### AI prompt/tool abuse
Untrusted project documents attempt to manipulate the model into revealing data or executing privileged tools.

Controls: retrieved content is data, tool authorization is independent of prompts, tools are least-privilege, writes begin as scenarios, deterministic validation is mandatory, and actions are audited.

### Availability attacks
Request floods, expensive reports/simulations, oversized imports, or resource-exhausting schedules.

Controls: rate/size/concurrency limits, job quotas, cancellation, bounded algorithms, isolated workers, and observability.

## Threat-model checkpoints

Review this threat model when introducing:
- authentication/session architecture;
- multi-tenancy/persistence;
- file import;
- external URL/webhook/integration access;
- proxy/private-network connectivity;
- AI tools;
- public APIs/service accounts;
- self-hosted deployment;
- cross-project resource pools;
- billing/payment handling.

Every review should produce concrete regression tests or operational controls, not merely prose.
