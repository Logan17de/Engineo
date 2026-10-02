use chrono::{DateTime, Utc};
use engineo_project_model::{
    Activity, ActivityKind, LagCalendarPolicy, ProjectDefinition, ProjectFinishPolicy, Relationship,
    RelationshipType, ScheduleInput, ScheduleOptions, WbsNode, Weekday, WorkCalendar, WorkInterval,
};
use engineo_scheduling::calculate_cpm;

fn utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("test timestamp must be valid")
        .with_timezone(&Utc)
}

fn standard_calendar() -> WorkCalendar {
    let work = vec![WorkInterval {
        start_local_hhmm: "08:00".to_owned(),
        end_local_hhmm: "16:00".to_owned(),
    }];

    WorkCalendar {
        id: "standard".to_owned(),
        name: "Standard".to_owned(),
        time_zone: "UTC".to_owned(),
        week: vec![
            (Weekday::Monday, work.clone()),
            (Weekday::Tuesday, work.clone()),
            (Weekday::Wednesday, work.clone()),
            (Weekday::Thursday, work.clone()),
            (Weekday::Friday, work),
        ],
        exceptions: Vec::new(),
    }
}

fn activity(id: &str, duration_minutes: u32) -> Activity {
    Activity {
        id: id.to_owned(),
        wbs_id: "wbs-root".to_owned(),
        name: id.to_owned(),
        kind: ActivityKind::Task,
        duration_minutes,
        calendar_id: "standard".to_owned(),
        constraints: Vec::new(),
    }
}

fn fs(predecessor: &str, successor: &str) -> Relationship {
    Relationship {
        predecessor_id: predecessor.to_owned(),
        successor_id: successor.to_owned(),
        relationship_type: RelationshipType::FinishToStart,
        lag_minutes: 0,
    }
}

fn schedule(
    activities: Vec<Activity>,
    relationships: Vec<Relationship>,
    finish_policy: ProjectFinishPolicy,
    required_finish: Option<&str>,
) -> ScheduleInput {
    ScheduleInput {
        schema_version: 1,
        project: ProjectDefinition {
            id: "project".to_owned(),
            name: "Backward pass test".to_owned(),
            planned_start_rfc3339: "2026-10-05T08:00:00Z".to_owned(),
            data_date_rfc3339: "2026-10-05T08:00:00Z".to_owned(),
            required_finish_rfc3339: required_finish.map(str::to_owned),
            default_calendar_id: "standard".to_owned(),
        },
        schedule_options: ScheduleOptions {
            critical_float_threshold_minutes: 0,
            lag_calendar_policy: LagCalendarPolicy::Successor,
            project_finish_policy: finish_policy,
        },
        calendars: vec![standard_calendar()],
        wbs: vec![WbsNode {
            id: "wbs-root".to_owned(),
            parent_id: None,
            code: "1".to_owned(),
            name: "Project".to_owned(),
            sort_order: 0,
        }],
        activities,
        relationships,
    }
}

#[test]
fn simple_chain_has_zero_total_and_free_float() {
    let input = schedule(
        vec![activity("A", 480), activity("B", 480)],
        vec![fs("A", "B")],
        ProjectFinishPolicy::Calculated,
        None,
    );

    let result = calculate_cpm(&input).expect("CPM succeeds");
    let a = result.activity_late("A").expect("A has late dates");
    let b = result.activity_late("B").expect("B has late dates");

    assert_eq!(a.late_start, utc("2026-10-05T08:00:00Z"));
    assert_eq!(a.late_finish, utc("2026-10-05T16:00:00Z"));
    assert_eq!(a.total_float_minutes, 0);
    assert_eq!(a.free_float_minutes, 0);
    assert!(a.critical);

    assert_eq!(b.late_start, utc("2026-10-06T08:00:00Z"));
    assert_eq!(b.late_finish, utc("2026-10-06T16:00:00Z"));
    assert_eq!(b.total_float_minutes, 0);
}

#[test]
fn shorter_parallel_path_receives_total_and_free_float() {
    let input = schedule(
        vec![
            activity("A", 480),
            activity("B", 480),
            activity("C", 240),
            activity("D", 480),
        ],
        vec![fs("A", "B"), fs("A", "C"), fs("B", "D"), fs("C", "D")],
        ProjectFinishPolicy::Calculated,
        None,
    );

    let result = calculate_cpm(&input).expect("CPM succeeds");
    let c = result.activity_late("C").expect("C has late dates");

    assert_eq!(
        result.early.activity("C").expect("C has early dates").early_start,
        utc("2026-10-06T08:00:00Z")
    );
    assert_eq!(c.late_start, utc("2026-10-06T12:00:00Z"));
    assert_eq!(c.total_float_minutes, 240);
    assert_eq!(c.free_float_minutes, 240);
    assert!(!c.critical);
}

#[test]
fn required_finish_can_create_negative_float() {
    let input = schedule(
        vec![
            activity("A", 480),
            activity("B", 480),
            activity("C", 480),
        ],
        vec![fs("A", "B"), fs("B", "C")],
        ProjectFinishPolicy::RequiredFinish,
        Some("2026-10-07T12:00:00Z"),
    );

    let result = calculate_cpm(&input).expect("CPM succeeds");

    assert_eq!(result.early.project_finish, utc("2026-10-07T16:00:00Z"));
    assert_eq!(result.late_project_finish, utc("2026-10-07T12:00:00Z"));

    for id in ["A", "B", "C"] {
        let dates = result.activity_late(id).expect("activity has late dates");
        assert_eq!(dates.total_float_minutes, -240);
        assert!(dates.critical);
    }
}

#[test]
fn multiple_successors_choose_the_most_restrictive_late_bound() {
    let input = schedule(
        vec![
            activity("A", 480),
            activity("B", 480),
            activity("C", 240),
            activity("D", 480),
        ],
        vec![fs("A", "B"), fs("A", "C"), fs("B", "D"), fs("C", "D")],
        ProjectFinishPolicy::Calculated,
        None,
    );

    let result = calculate_cpm(&input).expect("CPM succeeds");
    let a = result.activity_late("A").expect("A has late dates");

    assert_eq!(a.late_start, utc("2026-10-05T08:00:00Z"));
    assert_eq!(a.total_float_minutes, 0);
}

#[test]
fn relationship_types_participate_in_backward_pass() {
    let relationship_types = [
        RelationshipType::FinishToStart,
        RelationshipType::StartToStart,
        RelationshipType::FinishToFinish,
        RelationshipType::StartToFinish,
    ];

    for relationship_type in relationship_types {
        let input = schedule(
            vec![activity("A", 480), activity("B", 480)],
            vec![Relationship {
                predecessor_id: "A".to_owned(),
                successor_id: "B".to_owned(),
                relationship_type,
                lag_minutes: 0,
            }],
            ProjectFinishPolicy::Calculated,
            None,
        );

        let result = calculate_cpm(&input).expect("CPM succeeds");
        let a = result.activity_late("A").expect("A has late dates");

        assert!(
            a.late_start >= result.early.activity("A").expect("A early").early_start,
            "{relationship_type:?} unexpectedly produced negative float without a required finish"
        );
    }
}
