# Unfinished saved-view CLI source checkpoint

This is a new client implementation over published main
`4d38a05f6c4d03551340e45691d8118df9368b50`, using only the published pure
operation-contract interfaces from API PR #68 at
`f07567edf9902157fca8f671246f7c3f52979ac6`. It is not recovery of the earlier
unavailable local client work.

The `engineo views` namespace is under construction. It covers strict validation,
owned list/read/export, revision-bound create/update/delete preview and apply,
historical receipt status/recovery, and named/transient projection. Existing
configuration/scheduler commands retain their namespace and behavior. Only the
view `apply` command sends a view mutation; a plan is a stateless review.

## Verification so far

- Five focused argument/original-byte parser tests passed with runtime network
  and server I/O refused by a fail-closed test preload
- Fourteen pure DTO tests and the CLI typecheck/build passed
- Mocked command-flow tests are being completed
- Saved-view HTTP, database, browser, real-engine, GUI/headless parity and full
  aggregate acceptance have not run
- API PR #68 remains draft/held; this client checkpoint does not resolve its
  independent source/runtime blockers

The source checkpoint is intentionally unfinished and is not a merge, deployment,
production-readiness or current runtime acceptance claim. No new SQL, API,
database harness, migration, accounting, Rust, production dependency or workflow
change is included. CI/CodeQL push triggers remain restricted to main; no PR is
opened by this checkpoint and no checks are disabled or waived.

Verification tools: Node 24.19.0, TypeScript 5.9.3, tsx 4.20.5 loader, Biome 2.5.0
and pnpm 12.8.0. Official pinned development tools were installed into an isolated
directory with lifecycle scripts disabled; the repository lockfile is unchanged.
Use `node --import tsx` for these pure tests. The tsx CLI version command attempted
a local IPC listener and failed with EPERM; that listener was not retried.
