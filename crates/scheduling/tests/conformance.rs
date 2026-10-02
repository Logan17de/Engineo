mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use engineo_calendar::CompiledCalendar;
use engineo_project_model::RelationshipType;
use engineo_scheduling::{CpmResult, calculate_cpm};
use serde::Deserialize;

use common::{DensityProfile, activity, relationship, schedule, synthetic_dag};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    project_start: String,
    activities: Vec<FixtureActivity>,
    relationships: Vec<FixtureRelationship>,
    expected: ExpectedResult,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureActivity {
    id: String,
    duration_minutes: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureRelationship {
    predecessor: String,
    successor: String,
    #[serde(rename = "type")]
    relationship_type: String,
    lag_minutes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedResult {
    project_finish: String,
    controlling_path: Vec<String>,
    activities: BTreeMap<String, ExpectedActivity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedActivity {
    early_start: String,
    early_finish: String,
    total_float_minutes: i64,
    free_float_minutes: i64,
    critical: bool,
}

fn utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("fixture timestamp must be RFC 3339")
        .with_timezone(&Utc)
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/schedules/m0")
        .join(name)
}

fn load_fixture(name: &str) -> GoldenFixture {
    let content = fs::read_to_string(fixture_path(name)).expect("golden fixture must be readable");
    serde_json::from_str(&content).expect("golden fixture must be valid JSON")
}

fn relationship_type(value: &str) -> RelationshipType {
    match value {
        "FS" => RelationshipType::FinishToStart,
        "SS" => RelationshipType::StartToStart,
        "FF" => RelationshipType::FinishToFinish,
        "SF" => RelationshipType::StartToFinish,
        _ => panic!("unsupported fixture relationship type: {value}"),
    }
}

fn calculate_fixture(fixture: &GoldenFixture) -> CpmResult {
    let activities = fixture
        .activities
        .iter()
        .map(|value| activity(&value.id, value.duration_minutes))
        .collect();
    let relationships = fixture
        .relationships
        .iter()
        .map(|value| {
            relationship(
                &value.predecessor,
                &value.successor,
                relationship_type(&value.relationship_type),
                value.lag_minutes,
            )
        })
        .collect();
    let input = schedule(activities, relationships, &fixture.project_start);

    calculate_cpm(&input).expect("golden fixture must calculate")
}

#[test]
fn golden_parallel_float_fixture_matches_exact_output() {
    let fixture = load_fixture("parallel-float.json");
    let result = calculate_fixture(&fixture);

    assert_eq!(
        result.early.project_finish,
        utc(&fixture.expected.project_finish)
    );
    assert_eq!(
        result.early.controlling_path,
        fixture.expected.controlling_path
    );

    for (activity_id, expected) in &fixture.expected.activities {
        let early = result
            .early
            .activity(activity_id)
            .expect("expected activity must have early dates");
        let late = result
            .activity_late(activity_id)
            .expect("expected activity must have late dates");

        assert_eq!(
            early.early_start,
            utc(&expected.early_start),
            "{activity_id}"
        );
        assert_eq!(
            early.early_finish,
            utc(&expected.early_finish),
            "{activity_id}"
        );
        assert_eq!(
            late.total_float_minutes, expected.total_float_minutes,
            "{activity_id}"
        );
        assert_eq!(
            late.free_float_minutes, expected.free_float_minutes,
            "{activity_id}"
        );
        assert_eq!(late.critical, expected.critical, "{activity_id}");
    }
}

#[test]
fn extending_a_driving_duration_never_makes_project_finish_earlier() {
    for activity_count in 2..40 {
        let input = synthetic_dag(activity_count, DensityProfile::Sparse);
        let baseline = calculate_cpm(&input).expect("baseline schedule calculates");

        let mut extended = input.clone();
        let middle = activity_count / 2;
        extended.activities[middle].duration_minutes += 60;
        let changed = calculate_cpm(&extended).expect("extended schedule calculates");

        assert!(
            changed.early.project_finish >= baseline.early.project_finish,
            "activity count {activity_count}"
        );
    }
}

#[test]
fn adding_a_predecessor_never_makes_successor_earlier() {
    for predecessor_duration in [60, 120, 240, 480, 960] {
        let baseline = schedule(
            vec![activity("A", predecessor_duration), activity("B", 240)],
            Vec::new(),
            "2026-10-05T08:00:00Z",
        );
        let baseline_result = calculate_cpm(&baseline).expect("baseline calculates");

        let constrained = schedule(
            baseline.activities.clone(),
            vec![relationship("A", "B", RelationshipType::FinishToStart, 0)],
            "2026-10-05T08:00:00Z",
        );
        let constrained_result = calculate_cpm(&constrained).expect("relationship calculates");

        assert!(
            constrained_result
                .early
                .activity("B")
                .expect("B has dates")
                .early_start
                >= baseline_result
                    .early
                    .activity("B")
                    .expect("B has dates")
                    .early_start
        );
    }
}

#[test]
fn calculation_is_invariant_to_input_collection_order() {
    for profile in [DensityProfile::Sparse, DensityProfile::Dense] {
        let input = synthetic_dag(80, profile);
        let first = calculate_cpm(&input).expect("first calculation succeeds");

        let mut reordered = input;
        reordered.activities.reverse();
        reordered.relationships.reverse();
        let second = calculate_cpm(&reordered).expect("second calculation succeeds");

        assert_eq!(canonical_result(&first), canonical_result(&second));
        assert_eq!(
            fnv1a64(canonical_result(&first).as_bytes()),
            fnv1a64(canonical_result(&second).as_bytes())
        );
    }
}

#[test]
fn calculated_activity_spans_equal_their_working_durations() {
    let input = synthetic_dag(120, DensityProfile::Dense);
    let result = calculate_cpm(&input).expect("schedule calculates");
    let calendar = CompiledCalendar::compile(&input.calendars[0]).expect("calendar must compile");

    for activity in &input.activities {
        let dates = result
            .early
            .activity(&activity.id)
            .expect("activity must have early dates");

        assert!(
            calendar
                .is_working_instant(dates.early_start)
                .expect("start membership calculates")
        );
        assert_eq!(
            calendar
                .working_minutes_between(dates.early_start, dates.early_finish)
                .expect("working duration calculates"),
            i64::from(activity.duration_minutes),
            "{}",
            activity.id
        );
    }
}

fn canonical_result(result: &CpmResult) -> String {
    let mut output = format!(
        "project_finish={}\nlate_project_finish={}\npath={}\n",
        result.early.project_finish.to_rfc3339(),
        result.late_project_finish.to_rfc3339(),
        result.early.controlling_path.join(",")
    );

    for (activity_id, early) in &result.early.activities {
        let late = result
            .late
            .get(activity_id)
            .expect("every early activity must have late dates");
        output.push_str(&format!(
            "{activity_id}|{}|{}|{}|{}|{}|{}|{}\n",
            early.early_start.to_rfc3339(),
            early.early_finish.to_rfc3339(),
            late.late_start.to_rfc3339(),
            late.late_finish.to_rfc3339(),
            late.total_float_minutes,
            late.free_float_minutes,
            late.critical
        ));
    }

    output
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    bytes.iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}
