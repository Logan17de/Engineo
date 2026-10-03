# M1 Planner browser increment

The browser uses the reviewed tenant-scoped API and the Rust JSON schedule
bridge. It adds working project editing; it is one M1 increment, not the complete
M1 or production release. The remaining roadmap exits are in `ACCEPTANCE.md`.

## Workflow

An authenticated user can create an organization and project, add up to 1,000
activities per action, edit a virtualized activity table and synchronized Gantt,
restructure WBS groups, edit relationships, calendars and constraints, and change
schedule controls. A batch and the aggregate input remain subject to the API's
size limits. Filtering supports names and identifiers; grouping, sorting and
saved views are future work. Dates include the year and are explicitly UTC.

Save and recalculate validates the draft, submits its original expected revision,
and calculates the confirmed saved revision. Rust owns every calculated date,
float, finish and path; the web app only positions returned dates on the timeline.
Editing clears the old result so stale dates do not describe a new draft. The
current run result lives in memory; durable results and baseline comparison are
separate increments. Viewer controls reflect server permissions, and the API
independently rejects unauthorized writes and calculations.

## Failure and account state

Repeated clicks share one operation guard. A stopped request is not proof that
a database mutation was rolled back: the UI asks the user to reload the saved
version, and a stale retry is rejected by expected revision. Errors receive focus
and remain visible with the draft. Reload, project changes and explicit logout
ask before discarding unsaved edits. A failed organization load clears the
previous project's state before displaying the failure.

When a session expires, an unsaved draft may remain in volatile memory in that
tab. It is not persisted in browser storage or exposed on the sign-in screen.
Recovery requires the same immutable user ID and a fresh authorized project
read with write permission. It retains the original expected revision: another
writer still produces an explicit conflict. A different account or explicit
logout discards recovery. A save already confirmed by the API is not restored as
an unsaved draft when the following calculation/session request fails.

Planner requests bind to the public session identifier obtained from `/auth/me`.
The API rejects a supplied `X-Engineo-Session` that differs from the cookie's
authenticated session before authorization/mutation/export. This identifier is
not a credential: cookie authentication, CSRF and tenant RBAC remain required.
Non-Planner API consumers may omit the intent header; their authority is still
their authenticated principal, never a client-provided identity.

The tab also retains its CSRF-cookie fingerprint and an in-memory generation.
Requests and decoded responses must still match them. A changed binding clears
the old visible account/project/permissions before any network probe. Cookie
comparison and focus/visibility checks cover browsers without BroadcastChannel.
The probe has a five-second abort deadline and cannot repopulate the workspace.
Failures leave a usable sign-in form with any draft held only in volatile escrow,
scoped to its original immutable user, organization, project and revision.

Login and deliberate logout notifications have separate intent. Same-account
reauthentication preserves escrow; verified different accounts and deliberate
logout discard it. Restoring escrow requires the ordinary fresh identity,
organization, project and write-permission checks, and keeps its original
revision. Loss of write access discards escrow and loads the saved read-only
version. Notifications contain no credentials and no project data is stored in
browser storage. Explicit accepted logout clears the draft before awaiting
revocation; an already-expired session cannot resurrect it.

## Accessibility and export

The activity table uses semantic headers, indexed virtual rows, labelled inputs
and keyboard previous/next controls. Both the table and page can be navigated
using the keyboard; read-only rows do not need editable controls to navigate.
Malformed working-interval text stays visible and invalid, rather than being
silently truncated into a different calendar. Native labels, focus indicators
and live status/error messages are provided. Screen-reader and broader device
certification remain pending.

JSON export requires a saved draft and an authorized, audited API read. Download
bytes use the canonical contract serializer, including its trailing newline, so
SHA-256 matches the recorded input hash. Authentication state is excluded.
CSV/spreadsheet interoperability is not included in this increment.

## Runtime boundary

The web app calls same-origin `/api`; Next rewrites to a fixed configured
`ENGINEO_API_ORIGIN`, defaulting to `http://127.0.0.1:4000`. Configuration rejects
credentials, paths and non-HTTP(S) origins. API Origin/CSRF/session/RBAC checks
remain active. This is a fixed deployment upstream, not a user-configurable
network destination.

Production ingress integration still needs validation. The API deliberately
does not trust forwarded client addresses, so browser logins through one Next
instance share its source quota. The installed Next rewrite timeout defaults to
30 seconds, equal to the engine process deadline before database/audit work;
slow-calculation delivery and ingress timeout budgets need a coordinated fix.
Do not enable blanket forwarding trust to avoid the quota. Enterprise proxy,
CA trust, egress isolation and production transport/storage remain release gates.
