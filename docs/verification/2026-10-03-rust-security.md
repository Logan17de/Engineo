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

## Extraction gate

After the existing high/error query gate, Rust analysis must independently pass:

- One well-formed metric for files extracted cleanly and one for files with
  errors; missing, duplicated, conflicting or non-integer values fail.
- Zero files with errors and a clean-file count equal to the Git-tracked Rust
  source inventory.
- Extraction-location notifications for every tracked source, so clean counts
  cannot conceal a missing or substituted source file.
- No failed invocation, extraction-warning/error notification or error-level
  execution notification.

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

Dependency Review remains failed because Dependency Graph is disabled. No
repository setting or merge is changed. PM exact-head review and operational
release gates remain required.
