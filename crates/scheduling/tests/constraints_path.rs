use chrono::{DateTime, Utc};
use engineo_project_model::{
    Activity, ActivityConstraint, ActivityKind, ConstraintType, LagCalendarPolicy,
    ProjectDefinition, ProjectFinishPolicy, Relationship, RelationshipType, ScheduleInput,
    ScheduleOptions, WbsNode, Weekday, WorkCalendar, WorkInterval,
};
use engineo_scheduling::{DrivingCause, calculate_cpm, forward_pass};

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

fn constrained_activity(
    id: &str,
    duration_minutes: u32,
    constraint_type: ConstraintType,
    instant: &str,
) -> Activity {
    let mut value = activity(id, duration_minutes);
    value.constraints.push(ActivityConstraint {
        constraint_type,
        instant_rfc3339: instant.to_owned(),
    });
    value
}

fn fs(predecessor: &str, successor: &str) -> Relationship {
    Relationship {
        predecessor_id: predecessor.to_owned(),
        successor_id: successor.to_owned(),
        relationship_type: RelationshipType::FinishToStart,
        lag_minutes: 0,
    }
}

fn schedule(activities: Vec<Activity>, relationships: Vec<Relationship>) -> ScheduleInput {
    ScheduleInput {
        schema_version: 1,
        project: ProjectDefinition {
            id: "project".to_owned(),
            name: "Constraint test".to_owned(),
            planned_start_rfc3339: "2026-10-05T08:00:00Z".to_owned(),
            data_date_rfc3339: "2026-10-05T08:00:00Z".to_owned(),
            required_finish_rfc3339: None,
            default_calendar_id: "standard".to_owned(),
        },
        schedule_options: ScheduleOptions {
            critical_float_threshold_minutes: 0,
            lag_calendar_policy: LagCalendarPolicy::Successor,
            project_finish_policy: ProjectFinishPolicy::Calculated,
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
fn start_on_or_after_moves_early_start_and_records_driver() {
    let input = schedule(
        vec![constrained_activity(
            "A",
            240,
            ConstraintType::StartOnOrAfter,
            "2026-10-06T08:00:00Z",
        )],
        Vec::new(),
    );

    let result = forward_pass(&input).expect("forward pass succeeds");
    let a = result.activity("A").expect("A has dates");

    assert_eq!(a.early_start, utc("2026-10-06T08:00:00Z"));
    assert_eq!(a.early_finish, utc("2026-10-06T12:00:00Z"));
    assert_eq!(
        a.driving_causes,
        vec![DrivingCause::Constraint {
            constraint_type: ConstraintType::StartOnOrAfter,
            instant_rfc3339: "2026-10-06T08:00:00Z".to_owned(),
        }]
    );
}

#[test]
fn finish_on_or_after_derives_start_from_activity_duration() {
    let input = schedule(
        vec![constrained_activity(
            "A",
            240,
            ConstraintType::FinishOnOrAfter,
            "2026-10-06T12:00:00Z",
        )],
        Vec::new(),
    );

    let result = forward_pass(&input).expect("forward pass succeeds");
    let a = result.activity("A").expect("A has dates");

    assert_eq!(a.early_start, utc("2026-10-06T08:00:00Z"));
    assert_eq!(a.early_finish, utc("2026-10-06T12:00:00Z"));
}

#[test]
fn upper_constraint_can_create_negative_float_and_violation() {
    let input = schedule(
        vec![constrained_activity(
            "A",
            480,
            ConstraintType::FinishOnOrBefore,
            "2026-10-05T12:00:00Z",
        )],
        Vec::new(),
    );

    let result = calculate_cpm(&input).expect("CPM succeeds");
    let a = result.activity_late("A").expect("A has late dates");

    assert!(a.total_float_minutes < 0);
    assert!(a.critical);
    assert_eq!(result.constraint_violations.len(), 1);
    assert_eq!(
        result.constraint_violations[0].constraint_type,
        ConstraintType::FinishOnOrBefore
    );
    assert_eq!(
        result.constraint_violations[0].actual_instant,
        utc("2026-10-05T16:00:00Z")
    );
}

#[test]
fn controlling_path_follows_relationships_that_set_early_dates() {
    let input = schedule(
        vec![
            activity("A", 480),
            activity("B", 480),
            activity("C", 240),
            activity("D", 480),
        ],
        vec![fs("A", "B"), fs("A", "C"), fs("B", "D"), fs("C", "D")],
    );

    let result = forward_pass(&input).expect("forward pass succeeds");

    assert_eq!(
        result.controlling_finish_activity.as_deref(),
        Some("D")
    );
    assert_eq!(
        result.controlling_path,
        vec!["A".to_owned(), "B".to_owned(), "D".to_owned()]
    );
}

#[test]
fn later_constraint_becomes_root_of_controlling_path() {
    let input = schedule(
        vec![
            activity("A", 480),
            constrained_activity(
                "B",
                480,
                ConstraintType::StartOnOrAfter,
                "2026-10-07T08:00:00Z",
            ),
            activity("C", 480),
        ],
        vec![fs("A", "B"), fs("B", "C")],
    );

    let result = forward_pass(&input).expect("forward pass succeeds");

    assert_eq!(
        result.controlling_path,
        vec!["B".to_owned(), "C".to_owned()]
    );
}

#[test]
fn equal_relationship_and_constraint_bounds_are_both_preserved() {
    let input = schedule(
        vec![
            activity("A", 480),
            constrained_activity(
                "B",
                480,
                ConstraintType::StartOnOrAfter,
                "2026-10-06T08:00:00Z",
            ),
        ],
        vec![fs("A", "B")],
    );

    let result = forward_pass(&input).expect("forward pass succeeds");
    let b = result.activity("B").expect("B has dates");

    assert!(b.driving_causes.iter().any(|cause| matches!(
        cause,
        DrivingCause::Relationship {
            predecessor_id,
            relationship_type: RelationshipType::FinishToStart,
            lag_minutes: 0,
        } if predecessor_id == "A"
    )));
    assert!(b.driving_causes.iter().any(|cause| matches!(
        cause,
        DrivingCause::Constraint {
            constraint_type: ConstraintType::StartOnOrAfter,
            ..
        }
    )));
    assert_eq!(
        result.controlling_path,
        vec!["A".to_owned(), "B".to_owned()]
    );
}
