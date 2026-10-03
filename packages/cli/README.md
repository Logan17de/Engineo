# Engineo application CLI v1

Private workspace increment for an existing, explicitly selected project. This
Node client talks to the configuration API and existing Rust-backed calculation
API. It is separate from, and does not change, the Rust `engineo-schedule` CLI.
It is not a Terraform provider, does not create accounts/projects or automation
identities, and is not a production-readiness or publication claim.

Requires Node 24+ and the approved configuration API increment. Build from the
repository with the pinned/frozen dependencies:

```sh
pnpm install --frozen-lockfile
pnpm --filter @engineo/contracts build
pnpm --filter @engineo/cli build
node packages/cli/dist/main.js help
```

## Destination and ephemeral session material

Every remote invocation requires `--api-origin`, `--organization`, `--project`
and exactly one of `--auth-file` or `--auth-fd`. All IDs are native UUIDs.
The API origin is an origin only, without credentials, path, query or fragment.
`--app-origin` defaults to the API origin; set it to the deployed application's
allowed Origin when that differs. The client always sends a valid explicit Origin,
the current `X-Engineo-Session`, and CSRF on POST. There is no CLI/user-agent
authorization exemption.

Authentication JSON is supplied explicitly and kept outside configuration, saved
review and stdout/stderr. Its exact shape is:

```json
{
  "schemaVersion": 1,
  "kind": "engineo-cli-session",
  "actorId": "00000000-0000-0000-0000-000000000001",
  "sessionId": "00000000-0000-0000-0000-000000000002",
  "sessionToken": "EXPLICIT_EPHEMERAL_SESSION_MATERIAL",
  "csrfToken": "EXPLICIT_EPHEMERAL_CSRF_MATERIAL_XX"
}
```

The values above are placeholders, never real credentials. Tokens must be
32–256 base64url characters. The client verifies `/auth/me` against both supplied
immutable actor and current session before any project request. It does not log
in, accept passwords, extract browser cookies, create service keys, save auth
material or adopt a changed session. A new live session for the same actor can
read a historical receipt, but cannot apply/cancel an old-session pending review.

On POSIX, session files must be owned by the invoking user with no group/other
permissions (for example a pre-existing explicitly supplied file with mode 0600).
Symlinks and non-regular files are refused. `--auth-fd N` accepts an explicitly
opened descriptor N >= 3, including a bounded pipe. Use a dedicated descriptor:
the CLI may close a pipe/socket descriptor at EOF or interruption. The caller
cleans up its source and any separately owned descriptors. Pipes/sockets use
nonblocking polling so a still-open source cannot defeat the command deadline;
device/TTY descriptors are refused.
Never put tokens in command-line options, URL query strings, configuration,
review files, shell history or tracked files. Credential-shaped fields, known
supplied tokens, cookie text and Bearer tokens are refused in artifacts. This is
a guard against accidental sharing, not a general-purpose secret detector.

HTTPS and certificate verification are required. Disposable local development
may explicitly use `--allow-http-loopback` for canonical `localhost`, `127.0.0.1`
or `[::1]` origins. Non-loopback HTTP and URL parser aliases are refused.
There is no insecure-TLS option; `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused.
All redirects are refused, so cookies/CSRF are never forwarded to redirect targets.

## Commands and file contract

Run `help` for exact supported options. Unknown, duplicate, missing, positional,
credential and `--key=value` options are refused rather than guessed.

- `validate --file FILE --offline`: strict configuration JSON/schema/semantic
  validation without networking. Reports `authoritative:false` and
  `calculationChecked:false`
- `validate --file FILE --authoritative`: offline checks plus authorized native
  identity/persistence-compatible API validation. Reports `authoritative:true`
  and `calculationChecked:false`. Validation never runs Rust calculation
- `read` or `export [--out FILE]`: coherent canonical configuration with revision
  and verified input hash. Optional file contains only inert configuration v1;
  stdout retains revision/hash. Export is audited by the API
- `plan --file FILE --plan-id UUID --expected-revision N --out FILE`: create or
  exactly replay a caller-generated plan identity. Saves the full reviewed
  configuration, complete before/after changes and metadata/digest
- `status --plan-id UUID [--out FILE]`: query that exact original actor/session
  scoped plan. Optional file saves the complete available review
- `apply --plan FILE --expected-revision N`: apply only the saved reviewed plan
- `cancel --plan FILE --expected-revision N`: explicit durable cancellation.
  If apply already won, reports its historical receipt; never claims undo
- `receipt --plan-id UUID`: retrieve historical terminal evidence using the same
  actor's current authorized live session
- `calculate --expected-revision N`: invoke the existing Rust-backed
  `/schedule/run` API; no JavaScript schedule mathematics
- `result --expected-revision N`: get matching current stored result, or explicit
  `result:null,calculation:null` when no matching calculation exists

Configuration is `ProjectConfigurationV1`: schemaVersion 1, kind
`engineo-project-configuration`, scope `schedule`, complete engine input v1.
Use `export --out configuration.json` to start from native IDs. No code,
templates, environment substitution, includes, URLs or expressions are evaluated.
Destination, org/project selection, credentials and expected revision are explicit
out of band. Project code/description, memberships, results/audits and GUI views
are not overwritten by the schedule configuration protocol.

Saved review files use schemaVersion 1, kind `engineo-cli-reviewed-plan`, an exact
destination object (`apiOrigin`, `appOrigin`, `organizationId`, `projectId`) and
the complete server plan. The client validates versions, normalized configuration,
inverse reconstructed base and regenerated complete diff, desired input SHA-256,
and SHA-256 of the shared ordered review descriptor excluding reviewedDigest.
It checks actor/session/target, plan identity and explicit expected revision.
Copying just a digest or trimming a large diff cannot produce an accepted review.
The digest is consistency evidence, not a credential or evidence of human review.
Read the full saved file before applying it. Output is never silently truncated.

Outputs are new files only: no overwrite or symlink following. A private empty
output file is reserved before a plan request; only a complete successful review
is written and synced. Interrupted process termination can leave an empty or
incomplete non-applyable file. After inspection, choose a different output path
for the exact same plan ID when querying/replaying; do not invent a new identity.

Example workflow, using caller-created UUID/revision and an explicitly supplied
ephemeral session descriptor (API/app/organization/project options abbreviated):

```sh
node packages/cli/dist/main.js export $DEST --auth-fd 3 --out configuration.json 3< "$SESSION_FILE"
node packages/cli/dist/main.js validate --file configuration.json --offline
node packages/cli/dist/main.js plan $DEST --auth-fd 3 --file configuration.json --plan-id "$PLAN_ID" --expected-revision "$REVISION" --out review.json 3< "$SESSION_FILE"
# Inspect all of review.json before continuing
node packages/cli/dist/main.js apply $DEST --auth-fd 3 --plan review.json --expected-revision "$REVISION" 3< "$SESSION_FILE"
node packages/cli/dist/main.js receipt $DEST --auth-fd 3 --plan-id "$PLAN_ID" 3< "$SESSION_FILE"
```

`$DEST` above stands for the explicit destination options, not a CLI environment
configuration feature. The CLI does not read credentials/destination from env.
Avoid putting options into a shell string for real automation; use an argument
array or pass each option explicitly to avoid shell word-splitting.

## Machine-readable output and exit categories

stdout contains exactly one newline-terminated JSON envelope:

```json
{
  "schemaVersion": 1,
  "kind": "engineo-cli-output",
  "command": "receipt",
  "ok": true,
  "exitCode": 0,
  "data": { "historical": true, "receipt": {} }
}
```

The receipt above is abbreviated. Errors have `ok:false`, `exitCode`, and
`error:{category,code,message,details?}` instead of data. API exception text,
unrecognized error identifiers, response headers, tokens, file contents and
underlying exception stacks are never included. API denial details contain only
HTTP status; denied recovery queries also identify the original action/plan and
`outcomeKnown:false`. Offline configuration diagnostics are bounded by the shared contract.
For malformed JSON, diagnostic paths are reported at the root (`""`) so decoded
literal keys cannot expose credentials. Safe issue codes, counts and character
offset messages remain available. Error details and envelopes are credential-screened,
including offline commands that have no supplied session material.
stderr has no routine output. Do not parse human message text or assume receipt
revision is the current project revision; query `read` for current state.

- 0 success
- 2 usage, unsafe options/files/destination
- 3 invalid configuration/review JSON/input/transport-size validation
- 4 revision, review, expiry, cancellation or other explicit conflict
- 5 authentication, permission, CSRF, Origin or identity/session mismatch
- 6 capacity/rate-limit
- 7 unresolved mutation outcome after genuinely ambiguous transport
- 8 transport/deadline/redirect failure before a known mutation outcome
- 9 integrity/version/hash/artifact inconsistency
- 10 unavailable resource/service/artifact or unexpected safe failure
- 130 interruption; for a mutation `details.outcomeKnown:false` means unknown

The timeout defaults to 30 seconds for the whole invocation and is explicitly
bounded to 100–120000 ms. Configuration/request transport is at most 1 MiB,
auth material 8 KiB, complete saved review/configuration API response 16 MiB,
Rust result response 32 MiB. Inputs/responses use fatal UTF-8 decoding, strict
duplicate-key/numeric JSON parsing and bounded depth. Bounds reject rather than
truncate an applyable intent.

## Uncertainty, replay and cancellation

A lost successful mutation response triggers at most one authorized GET of the
same known plan/receipt or matching calculation. Recovery verifies exact identity,
revision, input/result hashes and metadata. Explicit API auth/integrity/conflict/
capacity failures are preserved and never cause a blind duplicate POST. A pending
plan or nonterminal receipt is not proof of rollback and remains exit 7 after a
lost mutation response. An expired deadline can prevent recovery; query later.

SIGINT/SIGTERM interrupt the active request and report interruption. They never
send cancellation automatically or claim rollback. Apply/cancel exact retries
must use the original reviewed artifact, same original live session, revision,
digest and destination. Plan exact retry must use the original caller-generated
planId, expectedRevision and same configuration. No automatic re-plan/rebase,
revision refresh, actor/session switch or replacement mutation identity occurs.

Receipts are immutable historical commit evidence. Matching apply replay may
return the original receipt after TTL or later project edits; it still requires
current authorization and the original session. Configuration artifact retention
may remove the heavy review while terminal receipt/identity history remains.
`artifactsAvailable:false` cannot be turned into a newly invented review.

Calculation/result verify current expected revision, canonical persisted input
SHA-256, complete Rust result structural coverage, canonical result SHA-256 and
metadata schema/contract/calculation identity/engine declaration. An engine version
declaration is not a cryptographic executable attestation. Calculation recovery
requires matching committed GET evidence; null result never establishes success.

## Verification and remaining scope

```sh
pnpm --filter @engineo/cli typecheck
pnpm --filter @engineo/cli test
pnpm --filter @engineo/cli build
ENGINEO_CLI_HTTP_TEST=1 pnpm --filter @engineo/cli test:http
```

HTTP acceptance uses the built CLI and production-built API over actual sockets
with disposable PostgreSQL and the real Rust binary. See the HTTP test fixture
for its required environment; the test skips unless explicitly enabled. Unit
mock transports do not substitute for socket/GUI parity. Root integration owns
exact-head full CI, GUI and 1,000-activity parity. There is no real credential,
identity provisioning, deployment, monitoring/backup, operational SLO or license
release in this increment.

## Private Planner views: client source increment

The additive `engineo views` namespace uses the private-view v1 interfaces from
API PR #68. That API is still draft/held. This client source increment has pure
mocked verification only; it is not saved-view HTTP, browser, real-engine,
GUI/headless parity or production acceptance. Existing commands above retain
their original namespace.

Run `engineo views help` for the closed option contract. Remote commands use the
same explicit origins, organization/project and existing private session file or
descriptor as the legacy CLI. No credential is stored in a configuration, review,
projection, receipt or command output.

```sh
# Configure only destination identifiers and the path to existing session material.
remote=(--api-origin "$API_ORIGIN" --app-origin "$APP_ORIGIN"
        --organization "$ORG_ID" --project "$PROJECT_ID"
        --auth-file "$SESSION_FILE")

engineo views validate --file private-view.json --offline
engineo views capabilities "${remote[@]}"
engineo views list "${remote[@]}" --limit 20
engineo views read "${remote[@]}" --view-id "$VIEW_ID" --out exported-view.json

# Use the server window from capabilities, an explicit caller UUID, and a current
# schedule revision. This only previews; it does not create a pending server plan.
engineo views plan "${remote[@]}" --action create --file private-view.json \
  --operation-window "$SERVER_WINDOW" --operation-id "$OPERATION_ID" \
  --expected-schedule-revision "$SCHEDULE_REVISION" --out create-review.json

# Only apply sends a view mutation. Preserve this exact review after uncertainty.
engineo views apply "${remote[@]}" --review create-review.json \
  --expected-schedule-revision "$SCHEDULE_REVISION"
engineo views status "${remote[@]}" --operation-window "$SERVER_WINDOW" \
  --operation-id "$OPERATION_ID" --review create-review.json

engineo views select "${remote[@]}" --view-id "$VIEW_ID" \
  --expected-schedule-revision "$SCHEDULE_REVISION" --out named-projection.json
engineo views project "${remote[@]}" --file private-view.json \
  --expected-schedule-revision "$SCHEDULE_REVISION"
```

Update previews additionally require `--view-id` and `--expected-view-revision`
alongside the complete replacement configuration. Delete previews require those
two flags and omit `--file`. Every preview must be saved to a new output path;
it is independently bound to the complete base/desired configurations, both
revisions, action, actor/original session, destination and operation identity.
Apply reads that complete saved review and sends only `{review,reviewedDigest}`.

Original view configuration/review bytes reject BOM, malformed UTF-8, duplicate
decoded keys, unknown fields, noncanonical numeric tokens and excessive depth or
size. Parse failures use fixed redacted diagnostics. Responses additionally require
the explicit session intent, `no-store` and exact JSON media type. Config/review
hash domains are independently checked; digests do not grant permission or prove
real-engine provenance.

For an unusable response after apply, recovery issues one status GET for the exact
original window/UUID, without another mutation. A recorded matching receipt is a
historical outcome; later view edits/deletion do not change it. Open-window absence
remains uncertain. Closed-window definitive absence is reported explicitly.
Interruption during apply or recovery retains the operation key and
`outcomeKnown:false`; it never implies cancellation. A new authenticated session
can query its actor's historical receipt, but cannot apply an old-session review.
Do not allocate a fresh UUID or infer completion from a same-named record.

`select` projects a named view for that invocation; it does not persist a current
selection, edit a schedule or calculate. `project` can use a transient strict
configuration. Both return the shared rows/counts/binding DTO, including legitimate
filtered empty results. Observable target/revision/hash, complete unfiltered
visibility, row/group identity/order/count and source-size invariants are checked.
Coherent source/result verification and real-engine compatibility remain the
authenticated API's responsibility.

New view files use exclusive creation and mode 0600, sync the complete file and
its parent directory, and never overwrite an existing path. Unsupported directory
sync or an oversized pretty export fails without claiming a durable artifact.
These syscalls do not establish hardware/filesystem crash acceptance. Keep the
complete review until the outcome is established; stdout delivery alone is not
a durable receipt. Windows/external HTTPS and operational durability remain unrun.
