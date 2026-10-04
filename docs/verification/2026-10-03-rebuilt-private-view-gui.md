# Unfinished rebuilt saved-view GUI checkpoint

New GUI client source rebuilt from verified published main
`4d38a05f6c4d03551340e45691d8118df9368b50` and the pure operation contracts
published in API PR #68 at `f07567edf9902157fca8f671246f7c3f52979ac6`.
This is not recovery of the unavailable earlier local GUI work.

The independent GUI increment now integrates owned private-view list/read/selection,
input-only local presentation, coherent saved calculated presentation, filter/sort/
WBS grouping, and ID-bound virtualized table rows. Stateless previews and explicit
revision-bound create/update/delete apply are separate from schedule mutation.
Unknown applies retain only original operation identity/receipt bindings, scoped by
actor/organization/project. Another action in that scope stays blocked until
historical receipt recovery or definitive closed-window absence. A historical
receipt never substitutes for current record state. Native is immutable.

Source review corrected stale-source presentation, tab-navigation state loss,
project-navigation recovery loss, and preview focus restoration. Additional numeric
editing and projectless account-switch refinements are still in progress.

## Client-only verification

- 42 strict response/parser/hash/protocol tests passed
- 81 mocked controller/race/revision/cancellation/recovery tests passed
- 59 pure projection tests and 28 component/SSR checks passed
- 29 mocked transport/session/media-type/byte-limit/safe-error checks passed
- 25 local SHA-256 known-vector/Web Crypto/padding checks passed
- Client TypeScript checking and static production-JavaScript emission pass
- Planner browser-platform bundle compilation passes; this is a static compiler
  check, not a started application or Next.js production/runtime acceptance

Tests use a fail-closed preload refusing runtime fetch/socket/listener I/O. SSR
requires `TSX_TSCONFIG_PATH=apps/web/tsconfig.json`; source compilation uses the
existing react-jsx configuration. Tools are isolated official pinned development
dependencies installed with lifecycle scripts disabled. Production package files
and the repository pnpm lockfile are unchanged.

No API, SQL, migration, accounting, database harness, engine, production dependency,
workflow or deployment change is included. No server, database, HTTP, application
connection, browser or aggregate acceptance check has run. API PR #68 remains
independently held. Focus, keyboard and actual scrolling still require separate
browser acceptance. Recovery is local memory only; leaving the tab can discard
unresolved identity despite an unload warning. This is unfinished and not merge-
or production-ready.

CI/CodeQL push triggers remain restricted to main. This source-only checkpoint has
no PR and does not trigger the held database workflow; checks are not disabled,
changed or waived.
