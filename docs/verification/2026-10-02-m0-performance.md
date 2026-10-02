# M0 scale evidence — saved Engineo cloud environment

Executed 2026-10-02 using the unchanged scheduling source inherited from auth
commit `f92e17d356d4c753cb4215aac0fb099013d8bf6e` (main engine at
`eca67208bae54b3b9d22d507f5471ac938c6f380`) and the regenerated Cargo.lock included
in this increment. Engine source did not change during measurement.

```bash
cargo test --release -p engineo-scheduling --test performance -- --ignored --nocapture
```

- Rust: `rustc 1.99.0 (b940084d7 2026-09-28)`, Cargo 1.99.0.
- OS: Debian GNU/Linux 13.6, Linux 6.18.44, x86_64.
- Host CPU: AMD EPYC 9V74; five exposed logical CPUs, container quota four cores
  (`cpu.max = 400000 100000`).
- Container memory limit: 16 GiB (`memory.max = 17179869184`).
- Build: Cargo release profile (optimized); timings measure calculation, not compilation.
- One measured run per generated profile/size. Shared virtualized hardware;
  no latency budget or statistical claim inferred. Peak RSS was not measured.

| Profile | Activities | Relationships | Calculation ms | Result |
| --- | ---: | ---: | ---: | --- |
| Sparse | 1,000 | 999 | 5 | passed |
| Dense | 1,000 | 7,913 | 26 | passed |
| Sparse | 10,000 | 9,999 | 57 | passed |
| Dense | 10,000 | 79,913 | 324 | passed |
| Sparse | 100,000 | 99,999 | 689 | passed |
| Dense | 100,000 | 799,913 | 3,351 | passed |

`engine_contract=1` in every output. The ignored scale test was explicitly
selected: one test passed, one ordinary smoke test filtered out, no failures.
Regular Rust formatting/Clippy and 45 active tests also passed in this environment.

This demonstrates the M0 measured-100k exit. It does not verify Planner browser
latency, API payload/queue limits, resources/cost engines or portfolio performance.
