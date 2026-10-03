# Unfinished rebuilt saved-view GUI checkpoint

New GUI client source rebuilt from verified published main
`4d38a05f6c4d03551340e45691d8118df9368b50` and the pure operation contracts
published in API PR #68 at `f07567edf9902157fca8f671246f7c3f52979ac6`.
This is not recovery of the unavailable earlier local GUI work.

First checkpoint: strict bounded browser DTO/hash verification, an auth/project-
scoped saved-view controller, private presentation controls, stateless previews,
revision-bound create/update/delete apply and original-operation receipt recovery.
Planner/table integration and full mocked client coverage are still in progress.

No API, SQL, migration, accounting, database harness, engine, production dependency,
lockfile, workflow or deployment change is included. No server, database, HTTP,
application connection, browser or aggregate acceptance check has run. API PR #68
remains independently held. This source is unfinished and is not merge-ready.

Client verification uses pinned official development tools installed in an isolated
verification directory with lifecycle scripts disabled. The first source increment
passes static TypeScript checking; component/state/SSR tests are being completed.

Repository CI/CodeQL push triggers are restricted to main; this unfinished branch
checkpoint has no PR and does not trigger the held database workflow. No checks
are disabled, changed or waived.
