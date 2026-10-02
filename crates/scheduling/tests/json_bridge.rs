use chrono::{DateTime, Utc};
use engineo_scheduling::{JsonBridgeError, calculate_schedule_json, parse_schedule_json};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../fixtures/contracts/v1/minimal-project.json");

#[test]
fn signed_lag_boundaries_are_validated_before_calendar_arithmetic() {
    let mut fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for sign in [-1_i64, 1_i64] {
        fixture["relationships"][0]["lagMinutes"] = json!(sign * i64::from(u32::MAX));
        assert!(parse_schedule_json(&fixture.to_string()).is_ok());
        fixture["relationships"][0]["lagMinutes"] = json!(sign * (i64::from(u32::MAX) + 1));
        assert!(matches!(
            parse_schedule_json(&fixture.to_string()),
            Err(JsonBridgeError::Calculation(
                engineo_scheduling::ScheduleError::LagOutOfRange(_)
            ))
        ));
    }
    fixture["relationships"][0]["lagMinutes"] = json!(i64::MIN);
    assert!(parse_schedule_json(&fixture.to_string()).is_err());
}

#[test]
fn versioned_json_bridge_has_exact_dates_and_stable_output() {
    let output = calculate_schedule_json(FIXTURE).expect("fixture must calculate");
    let result: Value = serde_json::from_str(&output).expect("output must be JSON");
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(result["activities"]["A110"]["totalFloatMinutes"], 0);
    assert_eq!(result["controllingPath"], json!(["A100", "A110"]));
    let finish = DateTime::parse_from_rfc3339(result["projectFinish"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(finish.to_rfc3339(), "2026-10-09T03:00:00+00:00");
    let mut reordered: Value = serde_json::from_str(FIXTURE).unwrap();
    reordered["activities"].as_array_mut().unwrap().reverse();
    assert_eq!(
        output,
        calculate_schedule_json(&reordered.to_string()).unwrap()
    );
}

#[test]
fn json_boundary_rejects_versions_enums_invalid_instants_and_cycles() {
    let mut fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    fixture["schemaVersion"] = json!(2);
    assert!(matches!(
        parse_schedule_json(&fixture.to_string()),
        Err(JsonBridgeError::UnsupportedSchemaVersion(2))
    ));
    fixture["schemaVersion"] = json!(1);
    fixture["relationships"][0]["type"] = json!("UNKNOWN");
    assert!(matches!(
        parse_schedule_json(&fixture.to_string()),
        Err(JsonBridgeError::InvalidEnum { .. })
    ));
    fixture["relationships"][0]["type"] = json!("FS");
    fixture["project"]["plannedStart"] = json!("2026-02-31T08:00:00Z");
    assert!(calculate_schedule_json(&fixture.to_string()).is_err());
    fixture["project"]["plannedStart"] = json!("2026-10-05T08:00:00+09:00");
    fixture["relationships"].as_array_mut().unwrap().push(
        json!({"predecessorId": "A110", "successorId": "A100", "type": "FS", "lagMinutes": 0}),
    );
    assert!(calculate_schedule_json(&fixture.to_string()).is_err());
}
