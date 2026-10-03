# Private Planner views v1: shared contracts and pure projection

## Scope and status

This is the first shared-layer slice, based on main
`e83e399660fa21efe832de11f9ae601c9abca8cd` / tree
`bcd03d7ea8cfd0972b57f5f8b2c6828fbfde68e6`. It adds two independent contracts
modules, their tests and additive package exports. It does **not** implement or
accept saved views, persistence, an API/CLI command, GUI controls, permissions,
operation receipts, storage retention or deployment. Existing schedule and
project-configuration parsers/serializers, Rust and application layers are unchanged.

`planner-view.ts` accepts inert private named configuration and produces canonical
bytes. `planner-presentation.ts` projects an already verified native snapshot to
activity/group rows without editing it or calculating schedule values. Later
wrappers must provide coherent authorized source data and use this same projection.

## Closed configuration

```json
{"schemaVersion":1,"kind":"engineo-planner-view","name":"Critical by WBS","visibility":"private","presentation":{"search":"","kind":"all","wbsId":null,"critical":"critical","sort":{"field":"earlyStart","direction":"asc"},"groupBy":"wbs"}}
```

All displayed fields are required. Every object rejects other fields. Supported
presentation values are:

- kind: `all`, `TASK`, `START_MILESTONE`, `FINISH_MILESTONE`
- critical: `all`, `critical`, `noncritical`
- wbsId: null or a UUID for exact **direct** WBS membership, not descendants
- sort.field: `native`, `name`, `durationMinutes`, `earlyStart`, `totalFloatMinutes`
- sort.direction: `asc` or `desc`; `native` permits only `asc`
- groupBy: `none` or `wbs`

There are no expressions, regular expressions, scripts, templates, remote schemas,
includes, extensions, environment interpolation or resources. Search/name text,
including URL-shaped text, is a plain inert string. Never execute, fetch, navigate
to or automatically linkify it. Configuration cannot contain tenant/project,
actor/session, credentials, ownership/audience, engine inputs/results, calculated
values, activity IDs/order or permissions. Shared visibility is rejected.

The built-in `NATIVE_PLANNER_PRESENTATION_V1` and its sort object are frozen. Native
has no predicates or grouping and uses native ascending order. Native/transient
selection has no named-config digest. A later application opens in Native and
must keep it usable independently of optional view loading.

## Original bytes, normalization and diagnostics

Use `parsePlannerViewConfigurationV1(string | Uint8Array)` on original transport
data, before any generic JSON parser. It returns a discriminated validation
result. Never use JSON.parse first: decoded duplicate keys and original numeric
spelling would be lost. The separate bounded lexer preserves this evidence.

- Raw compact/whitespace/escaped JSON transport is at most 8,192 UTF-8 bytes,
  inclusive; the complete raw body counts, not only normalized bytes
- Byte arrays use fatal UTF-8 decoding. A BOM, malformed JSON, decoded duplicate
  keys (including escape-equivalent keys) and unpaired surrogates are rejected
- JSON depth is at most eight containers, counting the root as one. Unknown
  nested content is parsed under the same depth bound before shape rejection
- JSON numeric tokens must be safe integers without exponent, fraction or
  negative-zero spelling. The only supported numeric config field is literal
  schemaVersion 1. Versions 0/2, numeric strings and coercions are rejected
- Each result has at most 20 issues, each path/message at most 256 UTF-16 units,
  plus totalCount/truncated. A fatal lexical error returns one bounded issue;
  totalCount is not a promise to recover all later syntax errors
- Names are at most 120 UTF-16 units and 512 UTF-8 bytes. They reject C0/C1
  controls, blank names and case-insensitive `Native`
- Search is at most 256 UTF-16 units and 1,024 UTF-8 bytes. HT/LF/CR are allowed
  as literal ordinary whitespace; other C0/C1 controls are rejected
- Original field bounds apply before trimming. Name/search use ECMAScript trim;
  no NFC normalization, case folding or interior whitespace rewriting is applied
- WBS UUIDs are normalized to lowercase; existence/authorization is a separate
  current-source check, never an offline parser claim

`validatePlannerViewConfigurationV1(unknown)` and
`validatePlannerPresentationV1(unknown)` check in-memory shape and return copied
normalized data. They reject nonplain prototypes, accessors, nonenumerable/symbol
properties and prototype-related names without invoking ordinary getters. Arrays
are not valid configuration objects. Actual arbitrary JavaScript proxies are not
a safe transport boundary: reflective proxy traps cannot be authenticated or made
inert by a type annotation. Prefer original JSON bytes at every external boundary.

Validators do no live reference, ownership, authorization or calculation check.
Syntax validity does not mean activation is available. Serializers validate and
throw `PlannerViewConfigurationError` if configuration is invalid.

## Canonical bytes and hash domain

`serializePlannerViewConfigurationV1` produces compact JSON without newline in
this exact field order: schemaVersion, kind, name, visibility, presentation;
presentation fields search, kind, wbsId, critical, sort, groupBy; sort fields field,
direction. Semantically equal property permutations normalize to identical bytes.

`serializePlannerViewHashPreimageV1` produces the following fixed ordered envelope:

```text
{"kind":"engineo-planner-view-v1-canonical","projectionVersion":1,"normalizationVersion":1,"configuration":<canonical configuration>}
```

The config digest is lowercase SHA-256 of the envelope's UTF-8 bytes. The caller
uses its normal Node/browser cryptographic implementation; the portable contracts
module does not perform I/O or introduce a crypto dependency. Schema, projection
and normalization version 1 are fixed. Projection/normalization are outside the
user-authored configuration; attempts to add them to config are rejected.

For the example above the envelope digest is
`0b60167cefa299e4ac774cda2aa78eb76a96eef17fd07d1280ee95328e12a346`.
Hashing raw config alone is a different operation. This domain is separate from
unchanged schedule/result hashes. A digest is consistency binding, not a credential,
authorization, signature, real-engine attestation or proof of human review.

## Projection trust boundary and preconditions

`projectPlannerPresentationV1(snapshot, calculationOrNull, selection)` returns
`PlannerProjectionV1`. The snapshot supplies organization/project UUIDs, positive
safe scheduleRevision, inputHashSha256, saved/unsaved state, currentEngineVersion
(null when unavailable) and native-order EngineProjectInputV1. The project ID must
match the input; activities/WBS must have unique UUIDs and valid direct membership.

The selection supplies projectionVersion=1, normalizationVersion=1, a normalized
presentation and configHashSha256 (null for Native/transient). A later named-view
wrapper must independently compute and compare this digest to the entire strict
normalized configuration. The projector can check its spelling and carry it in
binding, but cannot verify a name/config it was never given.

Before constructing `PlannerVerifiedCalculationV1`, API/GUI wrappers must:

1. Verify a live current session and current organization/project authorization
2. Obtain a coherent native snapshot/result; separate SQL reads are not sufficient
   to promise coherence. Bind the data to the current selected actor/session/scope
3. Independently hash unchanged schedule-input serialization and supported result
   serialization; compare metadata input/result hashes and saved scheduleRevision
4. Check supported result/schema/engine contract and the configured **real current**
   Rust engine's version. A declared version is not binary provenance/authentication
5. Reject/clear unsaved input for result-dependent selection, and abort or ignore
   older responses after edits, navigation, scope/session or authorization changes

The `verification: "caller-verified-current-engine"` marker explicitly records a
caller assertion. Neither it nor its TypeScript interface proves any of these
steps. Calling this projector with forged matching metadata does not authenticate
Rust origin or matching content hashes. Those checks are intentionally not replaced
by JavaScript schedule math or a fabricated verifier.

The projector enforces declaration consistency: same organization/project,
scheduleRevision and input hash, supported versions/current engine, valid metadata,
exact result activity-key coverage, supported result shape/finite safe integral
float and exact supported dates. Accessor/nonplain/cyclic inputs, sparse arrays,
extra/out-of-bounds array own properties (including `4294967295`), and prototype
keys are rejected. This is defensive boundary checking, not the full engine-input
validator or external authorization implementation.

## Immutable row semantics

- Build native index and result/WBS lookups once. No schedule/result arrays are
  sorted or mutated. Native sequence is the snapshot array, never canonical UUID
  serialization or result-object iteration order
- Search lowercases with ECMAScript toLowerCase and applies literal substring
  matching to name/lowercase UUID. Search/kind/direct-WBS/critical predicates use AND
- Critical uses Rust's boolean. Float uses its stored signed number; zero float
  never implies critical. No dates, float, paths or criticality are calculated here
- Exactly one primary sort is applied to a new list. Name order is lowercase
  UTF-16 code-unit order, never localeCompare/Intl. Duration/float use numeric order
- Equal keys use nativeIndex then exact activity ID. Descending changes only the
  primary comparison; equal-key native order is unchanged
- earlyStart compares Gregorian whole seconds normalized for numeric UTC offsets
  plus zero-padded fractional nanoseconds. Date.parse, formatted display text and
  floating fractional seconds are not used. Fractions of one through nine digits
  retain full represented precision and offset-equivalent instants tie exactly
- The currently supported date subset is four-digit years 0000–9999, real Gregorian
  dates, uppercase T/Z, hours 00–23, seconds 00–59, offsets HH:MM within 23:59.
  Leap seconds, signed/extended years and precision over nine digits are explicitly
  unavailable rather than truncated, guessed or reformatted. Stored timestamps stay
  byte-for-byte unchanged
- groupBy=wbs uses native WBS array order and exact direct membership, not parent
  order, sortOrder, labels or hierarchical roll-ups. Duplicate WBS UUIDs fail closed;
  each unique nonempty group has a distinct `group:wbs:<lowercase UUID>` header
- Header rows expose WBS identity/code/name and exact visible activity count only.
  They are not activities and have no bar, date/float aggregate or schedule ID
- Activity rows expose activityId, zero-based nativeIndex, one-based visible
  displayOrdinal excluding headers, and groupKey or null. Visual row count includes
  headers; visible/source activity counts and group count are separate
- Use this same visual sequence for grid and Gantt; retain the full verified result
  for the time domain. Filtering alone does not rescale the project Gantt

Binding carries source identity/revision/input hash/state, projection/normalization
version and selected config digest. It includes calculationId/result hash/engine
version only when critical/date/float is consumed. Input-only views may project an
unsaved draft and explicitly bind inputState=unsaved; they do not certify a save.

## Typed unavailability

An available projection with zero matching activities is an explicit empty result.
Unavailable outcomes have no partial rows:

- `view_result_required`: input_unsaved, calculation_missing, calculation_stale,
  calculation_invalid or engine_unsupported
- `view_reference_stale`: reference_stale for missing/deleted configured direct WBS
- `view_invalid`: source_invalid, presentation_invalid or version_unsupported

Result dependency is checked before filtering, even if the search would match no
rows. Missing/foreign/deleted WBS references are never widened to all activities.
The pure layer does not silently select Native or delete a saved record. Later GUI
wrappers must preserve selection/config, visibly pause unavailable calculated
views, display Native with a notice, and resume only after current verified data.
Input-only views continue without a result or current engine declaration.

## Verification boundaries

Contract tests cover canonical/Unicode/numeric/original-byte/duplicate/prototype/
accessor/depth/version limits and frozen Native. Projection tests cover exact Native
order, stable equality/descending ties, mixed activity kinds, AND filters, direct
WBS grouping, negative stored float, nanosecond/offset/century vectors, missing/stale/
corrupt/unsaved results and immutability.

The gated real-engine test takes `ENGINEO_PLANNER_VIEW_TEST_ENGINE`, checks its
engine-info, invokes that exact trusted binary on canonical input, computes exact
input/result hashes and projects 1,000 mixed task/milestone activities, a sparse 999-edge two-branch DAG,
two calendars, three nonempty direct WBS groups and one empty group. If unset, that one test is
explicitly skipped; the unit comparator fixtures do not claim Rust provenance.
It reports three initial and twenty warm pure-projection samples with named
Node/V8/OS/CPU, engine version and hashes. GC/heap deltas are uncontrolled and not
allocation measurements. The engine execution is outside projection timing.

This characterization is not a universal performance promise, a browser result,
API/CLI/Rust parity acceptance, a production-build latency record or saved-view
acceptance. Browser Unicode/casing parity, full real DB/socket flows, GUI keyboard/
focus/virtualization/action geometry, ownership/RBAC, durability/replay/storage/
restore, audits/security/CI and end-to-end latency remain unrun in this slice.
