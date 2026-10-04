# Unfinished rebuilt saved-view GUI checkpoint

This is new GUI client source, rebuilt from verified published main
`4d38a05f6c4d03551340e45691d8118df9368b50` and the pure operation contracts
published in API PR #68 at `f07567edf9902157fca8f671246f7c3f52979ac6`.
It is not recovery of the unavailable earlier local GUI work.

## Implemented client source

- Owned private-view list/read/selection, immutable Native, and transient local
  presentation with strict filtering, sorting and WBS grouping
- Input-only views use the shared projector with an exact current source hash;
  unsaved source is explicitly marked. Calculated-dependent views require a
  coherent saved API projection matching the independently hash-verified cached
  calculation and the exact shared projection. Current-source changes hide old
  calculated rows immediately; unavailable views never widen to Native
- Stateless before/after previews and explicit revision-bound create/update/delete
  apply. These actions do not modify schedule data, native IDs/order or calculations
- Unknown applies retain original identity/receipt bindings by actor/organization/
  project. Another mutation in that scope stays blocked until historical receipt
  recovery or definitive closed-window absence. Historical receipts do not
  substitute for current record reads. Renewed live sessions may recover the
  original actor's receipt without replaying an old-session preview
- Session, scope, revision and cancellation guards reject late responses, including
  cookie changes while browser hashing is pending. A verified account switch
  clears prior-account recovery before dependent organization/project reads
- Grouped and virtualized row edits/deletes use actual activity UUIDs. Incomplete
  numeric text is buffered by UUID through virtual-row/tab remounts, blocks saving,
  and survives same-user auth recovery. Confirmed saved loads reset editor state.
  Calculated-dependent row presentations are explicitly read-only for schedule edits

Independent read-only source review identified and corrected stale-source display,
tab state loss, abandoned project recovery, focus restoration, invalid numeric
editor disappearance/remount loss, and projectless account-switch retention. The
final bounded client review found no remaining concrete defect. This is a source
review, not browser or backend acceptance.

## Verified on 2026-10-04 UTC

The isolated client-only check script passes against the final local source:

- 292 tests passed; zero failures, cancellations or skips
  - 42 protocol/parser/hash/DTO checks
  - 82 mocked state/session/revision/cancellation/recovery checks
  - 59 projection/hash checks and 28 SSR/component checks
  - 29 mocked transport/bounds/header/safe-error checks
  - 25 local hash known-vector/Web Crypto/padding checks
  - 27 in-memory mounted numeric-editor/recovery/UUID-callback checks
- Contracts and GUI strict TypeScript checking pass
- Client formatting and lint pass
- Production-source JavaScript emission and static browser-platform Planner bundle
  compilation pass. No application or server is started

The tests use a fail-closed preload refusing runtime fetch/socket/listener I/O. React
mounted tests use only in-memory renderer objects; expected renderer deprecation
warnings are not browser results. SSR requires the existing react-jsx configuration.
Tools are isolated official, exact-pinned development dependencies installed with
lifecycle scripts disabled; the tooling lockfile freezes transitive versions.
Production package files and the repository pnpm lockfile are unchanged.

Reproduce in a fresh checkout (Node 24+):

```sh
npm ci --prefix verification/tooling --ignore-scripts --no-audit --no-fund
bash verification/check-rebuilt-private-view-gui.sh
```

An additional existing shared-projector/configuration pure suite passed 45 tests;
one opt-in performance benchmark was skipped. This is separate from the 292-check
GUI gate and does not imply performance acceptance.

## Held acceptance

No API, SQL, migration, accounting, database harness, engine, production dependency,
workflow or deployment change is included. No server, database, real HTTP,
application connection, browser, full Next.js build/runtime, GUI/headless live
parity or aggregate acceptance check has run. API PR #68 remains independently
held; this client source does not resolve its blockers. Browser focus, native
keyboard behavior and actual layout/scroll performance remain unverified.

Recovery is local memory only. An unload warning is shown for unresolved operations,
but leaving the tab or explicitly switching accounts may discard their identities.
Expired receipt retention cannot prove the historical outcome, so unresolved
same-scope mutations remain blocked while this page retains that identity.

This checkpoint is intentionally unfinished and is not merge- or production-ready.
CI/CodeQL push triggers remain restricted to main. No PR is opened, no checks are
changed or waived, and no merge or deployment is performed.
