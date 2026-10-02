use chrono::{DateTime, Utc};
use engineo_project_model::{
    Activity, ActivityKind, LagCalendarPolicy, ProjectDefinition, ProjectFinishPolicy,
    Relationship, RelationshipType, ScheduleInput, ScheduleOptions, WbsNode, Weekday, WorkCalendar,
    WorkInterval,
};
use engineo_scheduling::forward_pass;

fn utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("test timestamp must be valid")
        .with_timezone(&Utc)
}

fn calendar(id: &str, workdays: &[Weekday]) -> WorkCalendar {
    WorkCalendar {
        id: id.to_owned(),
        name: id.to_owned(),
        time_zone: "UTC".to_owned(),
        week: workdays
            .iter()
            .copied()
            .map(|day| {
                (
                    day,
                    vec![WorkInterval {
                        start_local_hhmm: "08:00".to_owned(),
                        end_local_hhmm: "16:00".to_owned(),
                    }],
                )
            })
            .collect(),
        exceptions: Vec::new(),
    }
}

fn activity(id: &str, duration_minutes: u32, calendar_id: &str) -> Activity {
    Activity {
        id: id.to_owned(),
        wbs_id: "wbs-root".to_owned(),
        name: id.to_owned(),
        kind: ActivityKind::Task,
        duration_minutes,
        calendar_id: calendar_id.to_owned(),
        constraints: Vec::new(),
    }
}

fn relationship(
    predecessor: &str,
    successor: &str,
    relationship_type: RelationshipType,
    lag_minutes: i64,
) -> Relationship {
    Relationship {
        predecessor_id: predecessor.to_owned(),
        successor_id: successor.to_owned(),
        relationship_type,
        lag_minutes,
    }
}

fn input(
    activities: Vec<Activity>,
    relationships: Vec<Relationship>,
    calendars: Vec<WorkCalendar>,
    lag_calendar_policy: LagCalendarPolicy,
) -> ScheduleInput {
    ScheduleInput {
        schema_version: 1,
        project: ProjectDefinition {
            id: "project".to_owned(),
            name: "Forward pass test".to_owned(),
            planned_start_rfc3339: "2026-10-05T08:00:00Z".to_owned(),
            data_date_rfc3339: "2026-10-05T08:00:00Z".to_owned(),
            required_finish_rfc3339: None,
            default_calendar_id: "standard".to_owned(),
        },
        schedule_options: ScheduleOptions {
            critical_float_threshold_minutes: 0,
            lag_calendar_policy,
            project_finish_policy: ProjectFinishPolicy::Calculated,
        },
        calendars,
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

fn standard_calendar() -> WorkCalendar {
    calendar(
        "standard",
        &[
            Weekday::Monday,
            Weekday::Tuesday,
            Weekday::Wednesday,
            Weekday::Thursday,
            Weekday::Friday,
        ],
    )
}

#[test]
fn fs_ss_ff_relationships_calculate_earliest_dates() {
    let cases = [
        (
            RelationshipType::FinishToStart,
            0,
            "2026-10-06T08:00:00Z",
            "2026-10-06T12:00:00Z",
        ),
        (
            RelationshipType::FinishToStart,
            120,
            "2026-10-06T10:00:00Z",
            "2026-10-06T14:00:00Z",
        ),
        (
            RelationshipType::FinishToStart,
            -120,
            "2026-10-05T14:00:00Z",
            "2026-10-06T10:00:00Z",
        ),
        (
            RelationshipType::StartToStart,
            0,
            "2026-10-05T08:00:00Z",
            "2026-10-05T12:00:00Z",
        ),
        (
            RelationshipType::StartToStart,
            120,
            "2026-10-05T10:00:00Z",
            "2026-10-05T14:00:00Z",
        ),
        (
            RelationshipType::FinishToFinish,
            0,
            "2026-10-05T12:00:00Z",
            "2026-10-05T16:00:00Z",
        ),
        (
            RelationshipType::FinishToFinish,
            120,
            "2026-10-05T14:00:00Z",
            "2026-10-06T10:00:00Z",
        ),
        (
            RelationshipType::FinishToFinish,
            -120,
            "2026-10-05T10:00:00Z",
            "2026-10-05T14:00:00Z",
        ),
    ];

    for (relationship_type, lag, expected_start, expected_finish) in cases {
        let schedule = input(
            vec![
                activity("A", 480, "standard"),
                activity("B", 240, "standard"),
            ],
            vec![relationship("A", "B", relationship_type, lag)],
            vec![standard_calendar()],
            LagCalendarPolicy::Successor,
        );

        let result = forward_pass(&schedule).expect("forward pass succeeds");
        let dates = result.activity("B").expect("B has dates");

        assert_eq!(
            dates.early_start,
            utc(expected_start),
            "unexpected start for {relationship_type:?} lag {lag}"
        );
        assert_eq!(
            dates.early_finish,
            utc(expected_finish),
            "unexpected finish for {relationship_type:?} lag {lag}"
        );
    }
}

#[test]
fn start_to_finish_uses_predecessor_start_as_finish_lower_bound() {
    let schedule = input(
        vec![
            activity("P", 480, "standard"),
            activity("A", 480, "standard"),
            activity("B", 240, "standard"),
        ],
        vec![
            relationship("P", "A", RelationshipType::FinishToStart, 0),
            relationship("A", "B", RelationshipType::StartToFinish, 0),
        ],
        vec![standard_calendar()],
        LagCalendarPolicy::Successor,
    );

    let result = forward_pass(&schedule).expect("forward pass succeeds");
    let a = result.activity("A").expect("A has dates");
    let b = result.activity("B").expect("B has dates");

    assert_eq!(a.early_start, utc("2026-10-06T08:00:00Z"));
    assert!(b.early_finish >= a.early_start);
}

#[test]
fn multiple_predecessors_choose_the_most_restrictive_bound() {
    let schedule = input(
        vec![
            activity("A", 240, "standard"),
            activity("B", 480, "standard"),
            activity("C", 240, "standard"),
        ],
        vec![
            relationship("A", "C", RelationshipType::FinishToStart, 0),
            relationship("B", "C", RelationshipType::FinishToStart, 0),
        ],
        vec![standard_calendar()],
        LagCalendarPolicy::Successor,
    );

    let result = forward_pass(&schedule).expect("forward pass succeeds");
    let c = result.activity("C").expect("C has dates");

    assert_eq!(c.early_start, utc("2026-10-06T08:00:00Z"));
    assert_eq!(c.early_finish, utc("2026-10-06T12:00:00Z"));
}

#[test]
fn milestones_have_zero_duration_at_their_earliest_working_instant() {
    let mut milestone = activity("M", 0, "standard");
    milestone.kind = ActivityKind::FinishMilestone;

    let schedule = input(
        vec![activity("A", 480, "standard"), milestone],
        vec![relationship("A", "M", RelationshipType::FinishToStart, 0)],
        vec![standard_calendar()],
        LagCalendarPolicy::Successor,
    );

    let result = forward_pass(&schedule).expect("forward pass succeeds");
    let milestone = result.activity("M").expect("milestone has dates");

    assert_eq!(milestone.early_start, milestone.early_finish);
    assert_eq!(milestone.early_start, utc("2026-10-06T08:00:00Z"));
}

#[test]
fn successor_calendar_controls_lag_when_configured() {
    let seven_day = calendar(
        "seven-day",
        &[
            Weekday::Monday,
            Weekday::Tuesday,
            Weekday::Wednesday,
            Weekday::Thursday,
            Weekday::Friday,
            Weekday::Saturday,
            Weekday::Sunday,
        ],
    );

    let schedule = input(
        vec![
            activity("A", 2400, "standard"),
            activity("B", 240, "seven-day"),
        ],
        vec![relationship("A", "B", RelationshipType::FinishToStart, 480)],
        vec![standard_calendar(), seven_day],
        LagCalendarPolicy::Successor,
    );

    let result = forward_pass(&schedule).expect("forward pass succeeds");
    let b = result.activity("B").expect("B has dates");

    assert_eq!(b.early_start, utc("2026-10-11T08:00:00Z"));
}

#[test]
fn predecessor_calendar_policy_counts_lag_on_predecessor_working_time() {
    let seven_day = calendar(
        "seven-day",
        &[
            Weekday::Monday,
            Weekday::Tuesday,
            Weekday::Wednesday,
            Weekday::Thursday,
            Weekday::Friday,
            Weekday::Saturday,
            Weekday::Sunday,
        ],
    );

    let schedule = input(
        vec![
            activity("A", 2400, "standard"),
            activity("B", 240, "seven-day"),
        ],
        vec![relationship("A", "B", RelationshipType::FinishToStart, 480)],
        vec![standard_calendar(), seven_day],
        LagCalendarPolicy::Predecessor,
    );

    let result = forward_pass(&schedule).expect("forward pass succeeds");
    let b = result.activity("B").expect("B has dates");

    assert_eq!(b.early_start, utc("2026-10-13T08:00:00Z"));
}

#[test]
fn output_is_independent_of_activity_and_relationship_input_order() {
    let activities = vec![
        activity("A", 480, "standard"),
        activity("B", 240, "standard"),
        activity("C", 240, "standard"),
    ];
    let relationships = vec![
        relationship("A", "B", RelationshipType::FinishToStart, 0),
        relationship("A", "C", RelationshipType::StartToStart, 120),
        relationship("C", "B", RelationshipType::FinishToFinish, 0),
    ];

    let first = input(
        activities.clone(),
        relationships.clone(),
        vec![standard_calendar()],
        LagCalendarPolicy::Successor,
    );
    let second = input(
        activities.into_iter().rev().collect(),
        relationships.into_iter().rev().collect(),
        vec![standard_calendar()],
        LagCalendarPolicy::Successor,
    );

    assert_eq!(
        forward_pass(&first).expect("first schedule succeeds"),
        forward_pass(&second).expect("second schedule succeeds")
    );
}
