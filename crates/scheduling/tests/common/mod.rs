use engineo_project_model::{
    Activity, ActivityKind, LagCalendarPolicy, ProjectDefinition, ProjectFinishPolicy,
    Relationship, RelationshipType, ScheduleInput, ScheduleOptions, WbsNode, Weekday, WorkCalendar,
    WorkInterval,
};

#[derive(Debug, Clone, Copy)]
pub enum DensityProfile {
    Sparse,
    Dense,
}

pub fn standard_calendar() -> WorkCalendar {
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

pub fn activity(id: &str, duration_minutes: u32) -> Activity {
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

pub fn relationship(
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

pub fn schedule(
    activities: Vec<Activity>,
    relationships: Vec<Relationship>,
    project_start: &str,
) -> ScheduleInput {
    ScheduleInput {
        schema_version: 1,
        project: ProjectDefinition {
            id: "conformance".to_owned(),
            name: "Conformance fixture".to_owned(),
            planned_start_rfc3339: project_start.to_owned(),
            data_date_rfc3339: project_start.to_owned(),
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

pub fn synthetic_dag(activity_count: usize, profile: DensityProfile) -> ScheduleInput {
    assert!(activity_count > 0);

    let activities = (0..activity_count)
        .map(|index| activity(&format!("A{index:06}"), 60 + ((index % 8) as u32 * 60)))
        .collect::<Vec<_>>();
    let offsets: &[usize] = match profile {
        DensityProfile::Sparse => &[1],
        DensityProfile::Dense => &[1, 2, 3, 5, 8, 13, 21, 34],
    };
    let mut relationships = Vec::new();

    for index in 0..activity_count {
        for offset in offsets {
            let successor = index + offset;
            if successor >= activity_count {
                continue;
            }

            relationships.push(relationship(
                &format!("A{index:06}"),
                &format!("A{successor:06}"),
                RelationshipType::FinishToStart,
                0,
            ));
        }
    }

    schedule(activities, relationships, "2026-10-05T08:00:00Z")
}
