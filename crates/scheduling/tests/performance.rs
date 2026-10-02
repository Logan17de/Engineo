mod common;

use std::time::Instant;

use engineo_scheduling::calculate_cpm;

use common::{DensityProfile, synthetic_dag};

#[test]
fn one_thousand_activity_smoke_benchmark_calculates() {
    let input = synthetic_dag(1_000, DensityProfile::Sparse);
    let started = Instant::now();
    let result = calculate_cpm(&input).expect("1k schedule must calculate");

    eprintln!(
        "engineo_benchmark profile=sparse activities=1000 relationships={} elapsed_ms={}",
        input.relationships.len(),
        started.elapsed().as_millis()
    );
    assert_eq!(result.early.activities.len(), 1_000);
}

#[test]
#[ignore = "manual benchmark: run with cargo test -p engineo-scheduling --test performance -- --ignored --nocapture"]
fn benchmark_m0_scale_profiles() {
    for activity_count in [1_000_usize, 10_000, 100_000] {
        for profile in [DensityProfile::Sparse, DensityProfile::Dense] {
            let input = synthetic_dag(activity_count, profile);
            let started = Instant::now();
            let result = calculate_cpm(&input).expect("benchmark schedule must calculate");
            let elapsed = started.elapsed();

            eprintln!(
                "engineo_benchmark profile={profile:?} activities={activity_count} relationships={} elapsed_ms={} engine_contract=1",
                input.relationships.len(),
                elapsed.as_millis()
            );
            assert_eq!(result.early.activities.len(), activity_count);
        }
    }
}
