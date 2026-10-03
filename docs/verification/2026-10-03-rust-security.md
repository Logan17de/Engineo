# Rust security extraction and compiler compatibility

PR #56 `0f18291829aa28ca1d276044243d92b75bb77f65` passed CI
`37083434654` and CodeQL high/error query gates `37083434608`, but the
Rust job `111088680159` still reported 17 files without errors and 2 with
errors. Both `io.rs` and `conformance.rs` had unbuilt procedural macros.
Complete extraction remained failed; the query gate did not check coverage.

The actual prior Rust SARIF artifact `11233562336` was downloaded and inspected
in the saved cloud environment. Its metric results confirm 17/2 across 19
tracked source files. It also records macro-expansion warnings on both files.
The new independent extraction gate rejects that unmodified report with the
exact incomplete-coverage counts. No diagnostic or security query is suppressed.

## Cause and correction

[CodeQL 2.27.1's toolchain selector](https://github.com/github/codeql/blob/codeql-cli/v2.27.1/rust/extractor/src/toolchain.rs)
uses Rust 1.97.0 for non-nightly projects, even when the project toolchain file
selects 1.99. The workspace previously declared `rust-version = "1.99"`.
Running the extractor's compiler against the reviewed source reproduces a Cargo
failure: each workspace crate requires rustc 1.99. That prevents building the
serde procedural macros needed for complete extraction. This explains the
observed extraction warnings; exact-head CodeQL must still confirm remediation.

The minimum supported compiler is now 1.97, verified by all active tests and
all-target/all-feature compilation on Rust 1.97.0. Development, formatting,
Clippy and default builds remain pinned to 1.99.0. The compiler requirement is
changed openly; no `--ignore-rust-version`, analysis exclusion or finding
suppression is used. A separate CI job tests this minimum on every change.

GitHub documents that [Rust supports only `build-mode: none`](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages#building-rust).
The workflow retains that mode and security-extended queries. A Rust-only
preparation step installs the compatible compiler and its standard-library
source, then compiles the locked workspace before extraction. This is not a
switch to an unsupported manual analysis mode.

The first exact-head attempt (`f7cd6ba`, CodeQL run `37085604094`) built the
macros and extracted all 19 tracked Rust files cleanly. The strict gate still
rejected two warnings in generated serde/serde_core `target/debug/build` sources.
The preparation build had placed these temporary sources inside the repository
before CodeQL's initial file scan; they are not standalone Cargo modules and
have no independent semantic analyzer. The analysis job now uses a Cargo target
directory under the runner's temporary directory for both preparation and
extraction. This keeps generated build outputs outside the repository inventory
while Cargo still provides their macro expansions to the application analysis.
No tracked source, query or diagnostic is excluded. The unchanged gate requires
19 clean sources and zero extraction errors on the corrected head.

## Extraction gate

After the existing high/error query gate, Rust analysis must independently pass:

- One well-formed metric for files extracted cleanly and one for files with
  errors; missing, duplicated, conflicting or non-integer values fail.
- Zero files with errors and a clean-file count equal to the Git-tracked Rust
  source inventory.
- Extraction-location notifications for every tracked source, so clean counts
  cannot conceal a missing or substituted source file.
- An explicit successful status for each invocation, with no extraction-warning/
  error notification or error-level execution notification. Missing, null or
  non-boolean success status fails; independent review identified this hardening
  gap and the malformed-status regressions now cover it.

Evidence artifacts are retained even if the gate fails. Query findings and
extraction completeness remain separate checks. Changes in the producer's
evidence format require review rather than silently passing.

## Executed validation

```bash
rustup toolchain install 1.97.0 --profile minimal --component rust-src
cargo +1.97.0 test --workspace --all-targets --all-features --locked
cargo +1.97.0 check --workspace --all-targets --all-features --locked
pnpm check:rust
node --test scripts/*.test.mjs
node scripts/check-rust-extraction.mjs <unmodified-prior-Rust-SARIF-directory>
```

Both compiler versions passed 50 active Rust tests. The manual performance
benchmark remains explicitly ignored by these automatic suites; its earlier
measured record is separate. Rust 1.99 formatting/Clippy and the 1.97 preflight
passed. Six security/extraction regressions passed. Script formatting/lint,
workflow YAML parsing and `git diff --check` passed. The actual prior SARIF
was rejected as expected (17 clean, 2 errors, 19 expected). Local full CodeQL
extraction has not been run; the new exact-head GitHub run is required.

The `f7cd6ba` exact-head CI run `37085604078` passed all checks, including all
18 browser cases, both Rust compiler suites and dependency audits. Its Rust
SARIF artifact `11260174069` was downloaded and inspected; the unchanged gate
also rejects its actual 19-clean/2-error result. Exact-head extraction after
moving generated build outputs remains pending.

Dependency Review remains failed because Dependency Graph is disabled. No
repository setting or merge is changed. PM exact-head review and operational
release gates remain required.

## Subsequent verified foundation integration

The corrected coverage implementation was later included in reviewed PR #59 and
atomic integration PR #60. Integration head `b29dd49f7d16bb79ab647d7f7875222d2b384d1a`,
synthetic merge `008a227565f46aa008563b14422daaddfedf4bff`, and merged main
`b36ecc4d9483b925583bbf9a673c0040436a63e1` all have exactly tree
`f626302e6bf0ffa68e55c6d060c0ca62b3bdddee`. CodeQL `37102353980` passed
both language query gates and the Rust inventory gate: **19 clean sources,
zero failed, 19 expected**, with empty high/error finding arrays.

Dependency Graph was explicitly authorized and enabled after the earlier
blocked runs. Main-based Dependency Review `37102353955` successfully reviewed
the complete accumulated dependency delta. PR #60 was independently approved
and merged atomically. The separately corrected actual-main head
`54678e0e055d9450f328541b2551a1372b9ba3b3` subsequently passed CI
`37105521355` and CodeQL `37105521386`; downloaded SARIF confirmed empty
high/error findings and 19 individually matched clean Rust sources / zero errors.
The historical failures above are not current coverage status.
Operational release, provenance and deployment gates remain incomplete.

## Initial durable-calculation draft coverage

Draft PR #63 added the declared engine-source identity build script and its CLI
identity test, bringing the tracked inventory to 21 Rust files. Exact head
`ca58d83a9370a2b88b5f15304a70102ae1f9a835` passed
[CodeQL `37106301496`](https://github.com/Logan17de/Engineo/actions/runs/37106301496):
both language query gates, **21 clean sources / zero failed / 21 expected**,
and empty high/error findings. The build script and identity test are covered;
the foundation's earlier 19-file count was not reused as acceptance.

That head is not approved: its separate browser CI failed repeated-click and
fixture-quota cases. Every correction still needs fresh exact-head CodeQL,
extraction completeness, dependency review and full browser/CI acceptance.
