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

M1 includes a conservative in-process login limiter.

This is sufficient for a single API instance and tests. Before horizontally scaling authentication, the limiter must move to a shared backing store or edge gateway so limits remain global.

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
