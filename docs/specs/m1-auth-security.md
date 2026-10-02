# M1 Identity, Sessions, RBAC, and Audit

## Authentication

M1 uses email/password authentication as the first local identity mechanism.

Passwords are derived with Node's built-in scrypt:
- unique random 128-bit salt;
- memory-hard parameters stored with the encoded hash;
- 64-byte derived key;
- constant-time verification.

Plaintext passwords are never persisted or logged.

Enterprise OIDC/SAML arrives later without replacing the session/RBAC boundary.

## Sessions

Successful login generates:
- a 256-bit random session token;
- a separate 256-bit CSRF token.

Only SHA-256 hashes of those secrets are stored in PostgreSQL.

Browser cookies:
- `engineo_session`: HttpOnly, SameSite=Lax, Secure in production;
- `engineo_csrf`: SameSite=Lax and readable by the browser client so it can echo the token in `X-CSRF-Token`.

Logout revokes the database session before clearing cookies. Expired/revoked sessions cannot authenticate.

## CSRF and origin checks

Cookie-authenticated state-changing routes require:
1. an active session;
2. CSRF cookie;
3. matching `X-CSRF-Token` header;
4. a match against the server-side CSRF hash.

When `APP_ORIGIN` is configured, browser `Origin` headers that do not match are rejected.

## RBAC

Organization roles:
- owner
- admin
- planner
- viewer

Project roles:
- manager
- planner
- viewer

Owners/admins inherit project access across their organization. Planner/viewer organization roles require explicit project membership for project access.

Permission checks are performed server-side for every protected operation. UI visibility is not authorization.

## MFA policy

The schema records `mfa_required` and `mfa_enrolled`.

M1 does not pretend to implement a second factor. If `mfa_required` is true, password-only login is blocked with `mfa_required`. A real second-factor challenge will be introduced as a separate capability.

## Audit

Successful login/logout are written as append-only audit events for each organization membership.

Failed login attempts intentionally do not write tenant audit records because the caller has not proven tenant identity. Rate limiting provides abuse control without leaking account membership.

## Rate limiting

`@fastify/rate-limit` enforces a 60-attempt / five-minute source-IP quota in an
`onRequest` hook, before parsing or credential lookup. Its custom PostgreSQL store
uses atomic UPSERTs, so replicas and restarts share the quota. IPv6 addresses are
normalized to /64 networks; mapped IPv4 addresses normalize to IPv4. Forwarding
headers are untrusted (`trustProxy: false`). Reverse proxies must retain this
guarantee; trusted-proxy configuration needs its own explicit deployment review.

A separate eight-attempt / five-minute normalized-account quota prevents rotating
source IPs from multiplying guesses against one account. Changing email does not
reset the independent source quota. Both successful and failed attempts consume
quota; unknown accounts get the same response and dummy password work.

Only SHA-256 bucket keys, saturated counters and expiry times are stored, never
plaintext emails/IPs. Indexed cleanup removes up to 1,000 expired rows at most
once per minute per instance during login traffic. Idle deployments can prune
expired rows operationally. Cleanup failure and storage failure fail closed.
The API keeps no unbounded bucket Map. Active-key storage under a distributed
flood still requires deployment ingress capacity controls and monitoring.

429 responses include `Retry-After`. Per-instance password/session work is capped
at four concurrent logins; saturation returns 503 with `Retry-After: 1`. Requests
are not queued indefinitely. The body is bounded by the API and login schema.
Database outages reject login before authentication and do not issue cookies.

Tests exercise concurrent shared counters, quota expiry, cleanup, malformed-body
counting, forwarded-header spoofing, email/case/whitespace/IP rotation, a second
API instance, unavailable limiter storage and idempotent work-gate release.

Primary implementation reference: [Fastify rate-limit documentation](https://github.com/fastify/fastify-rate-limit).

Limiter database stages admit at most 16 concurrent operations per API instance,
including callers sharing an in-flight cleanup. Cleanup advances its successful
deadline only after the DELETE completes; failures retry immediately. PostgreSQL
enforces 30-second statement, five-second lock and 30-second idle-transaction
deadlines. This avoids abandoning uncancelled SQL with a Promise race. The
hash/session work gate remains four. SHA-256 keys are dictionary-testable
pseudonyms, not anonymization; ingress quotas and idle retention remain deployment
controls.

Login/logout session changes and every tenant audit event commit in one
transaction; cookies are emitted only afterward. Audit-trigger failure fixtures
verify rollback and retry. Admin/owner project authorization joins the tenant's
project record before returning an allowed decision.

## Security headers

Every API response receives:
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- Referrer-Policy: no-referrer
- restrictive Permissions-Policy
- restrictive API Content-Security-Policy
- HSTS in production

M1 remains same-origin by default and does not emit permissive CORS headers.

## Tests

Security integration tests cover:
- scrypt password verification;
- session issuance;
- secure auth cookies;
- authenticated `/auth/me`;
- missing-CSRF rejection;
- successful CSRF-protected logout;
- revoked-session rejection;
- project RBAC;
- auth audit events;
- MFA-required password login blocking.

Database-backed test files run serially against the disposable CI PostgreSQL service to avoid schema/migration races.
