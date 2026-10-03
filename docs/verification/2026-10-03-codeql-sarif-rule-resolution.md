# CodeQL SARIF rule-resolution verification

## Scope

This repair changes only `scripts/check-codeql.mjs` and its regression tests.
It resolves driver and extension rule references before applying the existing
security gate: reject security severity >= 7 or an effective result/override/default
level of `error`. Suppressed and unchanged findings remain subject to the gate.
No CodeQL query, workflow, extraction checker, security setting, or finding
suppression is changed.

Base: `8a6df65f217504163ce5d67cd1ee2ecfb90caeb7`, tree
`579c701baca2502b4f604eadbd14e9d3896ef1ba` (PR #65's original head).

## Rule-reference contract

The implementation follows the [OASIS SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
sections 3.7.4, 3.20.5, 3.27.5–7/10, 3.48.6, 3.51–52, and 3.54, and the
[official schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json).

- `rule.toolComponent.index` indexes `tool.extensions` directly; the driver
  does not occupy a synthetic extension slot
- Without a component index/GUID, the driver is the default. A name validates
  the selected component; it does not search extensions
- Component and rule GUID lookup must be unique. Supplied index, GUID, name,
  and ID references must agree. A GUID is compared case-insensitively
- Nested `rule.id` / `rule.index` default to `ruleId` / `ruleIndex`; explicitly
  supplied pairs must agree. Index `-1` denotes an unknown/unset index
- Rules are resolved only inside their declared component. An index can
  disambiguate duplicate IDs. A result ID may add exactly one hierarchical
  component to its indexed/GUID-resolved descriptor's ID
- The existing driver ID-only producer shape remains supported when exact
  ID lookup is unique. A possible one-component-prefix descriptor makes
  that fallback ambiguous and is rejected. ID-only lookup never searches
  extensions; extension descriptors require an index or GUID
- Missing, malformed, conflicting, unknown, or ambiguous references fail
  closed. Supplied security severity must be a finite decimal number in
  `[0, 10]`; malformed levels and metadata cannot silently become harmless
- An absent security score still defaults to zero for compatibility with
  non-security rules; an `error` level independently rejects the finding

## Actual artifact checks

The original PR #65 JavaScript artifact has empty `tool.driver.rules` and
references `tool.extensions[1].rules[34]`. The repaired gate exits **1** with
one genuine finding, rather than crashing on unknown metadata:

- Rule: `js/disabling-certificate-validation`
- Security severity: **7.5**
- Default/effective level: **error**
- Source location: `packages/cli/src/cli.test.ts:577`
- Decoded SARIF SHA-256:
  `3792138ff11e99efa9a16da1204f7ce37fa6bd9ec4a013a83005bee53b03eede`
- Source CodeQL run: `37120423612`, JavaScript job: `111195288378`

The TLS test implementation is repaired separately; this gate does not waive,
filter, or alter the original finding.

Previously verified green actual-main reports at commit
`a9d67cdfb24c4fe4848f109b699de63296127ae8`, tree
`c9e637ee9cbc83f639e9e6b4d658c331d1e282b9`, both remain clear (exit **0**,
zero high/error findings):

- JavaScript SARIF SHA-256:
  `c1597747275d75e54b7a49974666c81713bbfadbc94c8393676153be0ef2a6ea`
- Rust SARIF SHA-256:
  `8d56611499359efd07a7280c3575e4c13f6ec479af65399259df57bbf3e571e1`

These green artifacts validate gate compatibility; they are not evidence of a
fresh CodeQL analysis on the repaired PR head.

## Local checks

- Focused SARIF gate tests: **102 passed, zero failures/skips**
- Aggregate script tests: **123 passed, zero failures, one PostgreSQL-dependent
  test skipped** because no `DATABASE_URL` was configured
- JavaScript script syntax checks, repository Biome formatting/lint,
  Rust formatting, all package/E2E TypeScript checks, production builds, and
  offline workspace/all-targets Clippy: passed
- Lint retains five preexisting non-null-assertion warnings and one preexisting
  Biome configuration deprecation notice
- Initial aggregate script run preceded the contracts build and failed on its
  missing generated output; rebuilding the contracts and rerunning passed
- Initial combined formatting command lacked Cargo on `PATH`; rerunning with
  the existing Rust 1.99.0 tools passed
- Production build regenerated `apps/web/next-env.d.ts`; that generated
  change was restored to the exact base contents and is excluded from this patch

The full PostgreSQL-dependent application test suite and browser acceptance
were not run for this gate-only repair. Browser execution remains unavailable
under the existing denial. No dependency audit, server, publication, merge,
or deployment was attempted.

## Invocation override contract

The gate also resolves invocation `ruleConfigurationOverrides` using the same
component-scoped rule resolver. Override descriptors require an index or GUID;
the result-only legacy driver ID fallback is not extended to overrides.
A supplied descriptor ID, index, GUID, and component must consistently identify
the same metadata. Missing or malformed overrides and duplicate/conflicting
overrides for one descriptor fail closed. Default/override configuration keys
and the enabled, level, rank, parameters, and properties types are validated
against the official reportingConfiguration schema; a misspelled level cannot
silently fall back to warning.

Under section 3.48.6, an absent result `provenance.invocationIndex` defaults to
zero when `run.invocations` contains exactly one invocation, and otherwise to
`-1` (unknown). A supplied `-1` remains unknown. An out-of-range, malformed, or
missing-array invocation reference fails closed. Unknown attribution with an
applicable rule override fails closed when the result level must be derived,
instead of choosing a convenient invocation. A validated explicit result level
determines severity without requiring otherwise-unknown invocation attribution;
malformed or out-of-range explicit references still fail.
Multiple invocations without an applicable override retain default-level
behavior.

Under sections 3.27.10 and 3.51.3, a validated explicit result level takes
precedence; otherwise, an attributed override level is used, then the descriptor
default level, then `warning`. An override without a level preserves the
descriptor default. Overrides never lower the independent high/critical
security-score threshold, and suppressions/baseline states never skip findings.
None of the three supplied actual artifacts has invocation overrides; the
new effective-error behavior is verified through synthetic focused regressions.
