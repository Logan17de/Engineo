use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn bridge_reports_declared_source_identity_and_rejects_an_unmatched_pin() {
    let binary = env!("CARGO_BIN_EXE_engineo-schedule");
    let info = Command::new(binary).arg("--engine-info").output().unwrap();
    assert!(info.status.success());
    let value: serde_json::Value = serde_json::from_slice(&info.stdout).unwrap();
    assert_eq!(value["engineContractVersion"], 1);
    let version = value["engineVersion"].as_str().unwrap();
    assert!(version.starts_with("engineo-scheduling/0.1.0+source-fnv1a-"));
    assert!(version.len() < 128);

    let rejected = Command::new(binary)
        .args(["--engine-version", "unmatched-build"])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());

    let input = include_str!("../../../fixtures/contracts/v1/minimal-project.json");
    let mut child = Command::new(binary)
        .args(["--engine-version", version])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let calculated = child.wait_with_output().unwrap();
    assert!(calculated.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calculated.stdout).unwrap(),
        serde_json::from_str::<serde_json::Value>(
            &engineo_scheduling::calculate_schedule_json(input).unwrap()
        )
        .unwrap()
    );
}
