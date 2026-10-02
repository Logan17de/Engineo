use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use engineo_calendar::{CompiledCalendar, WorkMinutes};
use engineo_project_model::{
    Activity, ActivityId, CalendarId, ProjectFinishPolicy, Relationship, RelationshipType,
    ScheduleInput,
};

use crate::forward::{compile_calendars, lag_calendar, shift_by_lag};
use crate::{EarlyDates, ForwardPassResult, ScheduleError, ScheduleGraph, forward_pass};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LateDates {
    pub activity_id: ActivityId,
    pub late_start: DateTime<Utc>,
    pub late_finish: DateTime<Utc>,
    pub total_float_minutes: i64,
    pub free_float_minutes: i64,
    pub critical: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpmResult {
    pub early: ForwardPassResult,
    pub late: BTreeMap<ActivityId, LateDates>,
    pub late_project_finish: DateTime<Utc>,
}

impl CpmResult {
    #[must_use]
    pub fn activity_late(&self, activity_id: &str) -> Option<&LateDates> {
        self.late.get(activity_id)
    }
}

pub fn calculate_cpm(input: &ScheduleInput) -> Result<CpmResult, ScheduleError> {
    let early = forward_pass(input)?;
    backward_pass(input, early)
}

pub fn backward_pass(
    input: &ScheduleInput,
    early: ForwardPassResult,
) -> Result<CpmResult, ScheduleError> {
    let graph = ScheduleGraph::build(&input.activities, &input.relationships)?;
    let calendars = compile_calendars(input)?;
    let activities = input
        .activities
        .iter()
        .map(|activity| (activity.id.as_str(), activity))
        .collect::<BTreeMap<_, _>>();
    let outgoing = outgoing_relationships(&input.relationships);

    let project_calendar = calendars
        .get(&input.project.default_calendar_id)
        .ok_or_else(|| ScheduleError::MissingCalendar(input.project.default_calendar_id.clone()))?;

    let late_project_finish = match input.schedule_options.project_finish_policy {
        ProjectFinishPolicy::Calculated => early.project_finish,
        ProjectFinishPolicy::RequiredFinish => {
            let value = input
                .project
                .required_finish_rfc3339
                .as_ref()
                .ok_or_else(|| ScheduleError::InvalidRequiredFinish("missing".to_owned()))?;
            DateTime::parse_from_rfc3339(value)
                .map_err(|_| ScheduleError::InvalidRequiredFinish(value.clone()))?
                .with_timezone(&Utc)
        }
    };

    let topological = graph.topological_activity_ids();
    let mut late = BTreeMap::<ActivityId, LateDates>::new();

    for activity_id in topological.into_iter().rev() {
        let activity = activities
            .get(activity_id)
            .copied()
            .ok_or_else(|| ScheduleError::MissingActivity(activity_id.to_owned()))?;
        let activity_calendar = calendars
            .get(&activity.calendar_id)
            .ok_or_else(|| ScheduleError::MissingCalendar(activity.calendar_id.clone()))?;

        let mut late_start = terminal_late_start(
            activity_calendar,
            late_project_finish,
            activity.duration_minutes,
        )?;

        if let Some(relationships) = outgoing.get(activity_id) {
            for relationship in relationships {
                let successor = activities
                    .get(relationship.successor_id.as_str())
                    .copied()
                    .ok_or_else(|| {
                        ScheduleError::MissingActivity(relationship.successor_id.clone())
                    })?;
                let successor_dates = late
                    .get(&relationship.successor_id)
                    .ok_or_else(|| {
                        ScheduleError::MissingSuccessorDates(relationship.successor_id.clone())
                    })?;
                let lag_calendar = lag_calendar(
                    input.schedule_options.lag_calendar_policy,
                    activity,
                    successor,
                    project_calendar,
                    &calendars,
                )?;

                let candidate = predecessor_start_upper_bound(
                    relationship,
                    successor_dates.late_start,
                    successor_dates.late_finish,
                    activity,
                    activity_calendar,
                    lag_calendar,
                )?;
                late_start = late_start.min(candidate);
            }
        }

        let late_finish = activity_calendar.add_work_duration(
            late_start,
            WorkMinutes::new(activity.duration_minutes),
        )?;
        let early_dates = early
            .activity(activity_id)
            .ok_or_else(|| ScheduleError::MissingActivity(activity_id.to_owned()))?;
        let total_float_minutes =
            activity_calendar.working_minutes_between(early_dates.early_start, late_start)?;
        let free_float_minutes = calculate_free_float(
            input,
            activity,
            early_dates,
            &early,
            &activities,
            &calendars,
            project_calendar,
            outgoing.get(activity_id).map(Vec::as_slice).unwrap_or(&[]),
            total_float_minutes,
        )?;
        let threshold = i64::try_from(input.schedule_options.critical_float_threshold_minutes)
            .unwrap_or(i64::MAX);

        late.insert(
            activity.id.clone(),
            LateDates {
                activity_id: activity.id.clone(),
                late_start,
                late_finish,
                total_float_minutes,
                free_float_minutes,
                critical: total_float_minutes <= threshold,
            },
        );
    }

    Ok(CpmResult {
        early,
        late,
        late_project_finish,
    })
}

fn terminal_late_start(
    calendar: &CompiledCalendar,
    project_finish: DateTime<Utc>,
    duration_minutes: u32,
) -> Result<DateTime<Utc>, ScheduleError> {
    if duration_minutes == 0 {
        return Ok(calendar.previous_work_instant(project_finish)?);
    }

    let late_finish = calendar.previous_work_instant(project_finish)?;
    Ok(calendar.subtract_work_duration(
        late_finish,
        WorkMinutes::new(duration_minutes),
    )?)
}

fn predecessor_start_upper_bound(
    relationship: &Relationship,
    successor_start: DateTime<Utc>,
    successor_finish: DateTime<Utc>,
    predecessor: &Activity,
    predecessor_calendar: &CompiledCalendar,
    lag_calendar: &CompiledCalendar,
) -> Result<DateTime<Utc>, ScheduleError> {
    let successor_anchor = match relationship.relationship_type {
        RelationshipType::FinishToStart | RelationshipType::StartToStart => successor_start,
        RelationshipType::FinishToFinish | RelationshipType::StartToFinish => successor_finish,
    };
    let predecessor_event_bound =
        shift_by_lag(lag_calendar, successor_anchor, -relationship.lag_minutes)?;

    match relationship.relationship_type {
        RelationshipType::FinishToStart | RelationshipType::FinishToFinish => {
            if predecessor.duration_minutes == 0 {
                return Ok(predecessor_calendar.previous_work_instant(predecessor_event_bound)?);
            }

            let finish = predecessor_calendar.previous_work_instant(predecessor_event_bound)?;
            Ok(predecessor_calendar.subtract_work_duration(
                finish,
                WorkMinutes::new(predecessor.duration_minutes),
            )?)
        }
        RelationshipType::StartToStart | RelationshipType::StartToFinish => {
            Ok(predecessor_calendar.previous_work_instant(predecessor_event_bound)?)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn calculate_free_float(
    input: &ScheduleInput,
    activity: &Activity,
    early_dates: &EarlyDates,
    early: &ForwardPassResult,
    activities: &BTreeMap<&str, &Activity>,
    calendars: &BTreeMap<CalendarId, CompiledCalendar>,
    project_calendar: &CompiledCalendar,
    outgoing: &[&Relationship],
    total_float_minutes: i64,
) -> Result<i64, ScheduleError> {
    if outgoing.is_empty() {
        return Ok(total_float_minutes);
    }

    let activity_calendar = calendars
        .get(&activity.calendar_id)
        .ok_or_else(|| ScheduleError::MissingCalendar(activity.calendar_id.clone()))?;
    let mut free_float = i64::MAX;

    for relationship in outgoing {
        let successor = activities
            .get(relationship.successor_id.as_str())
            .copied()
            .ok_or_else(|| ScheduleError::MissingActivity(relationship.successor_id.clone()))?;
        let successor_early = early
            .activity(&relationship.successor_id)
            .ok_or_else(|| ScheduleError::MissingActivity(relationship.successor_id.clone()))?;
        let lag_calendar = lag_calendar(
            input.schedule_options.lag_calendar_policy,
            activity,
            successor,
            project_calendar,
            calendars,
        )?;
        let latest_without_moving_successor = predecessor_start_upper_bound(
            relationship,
            successor_early.early_start,
            successor_early.early_finish,
            activity,
            activity_calendar,
            lag_calendar,
        )?;
        let relationship_float = activity_calendar
            .working_minutes_between(early_dates.early_start, latest_without_moving_successor)?;

        free_float = free_float.min(relationship_float);
    }

    Ok(free_float)
}

fn outgoing_relationships<'a>(
    relationships: &'a [Relationship],
) -> BTreeMap<&'a str, Vec<&'a Relationship>> {
    let mut outgoing = BTreeMap::<&str, Vec<&Relationship>>::new();

    for relationship in relationships {
        outgoing
            .entry(relationship.predecessor_id.as_str())
            .or_default()
            .push(relationship);
    }

    for values in outgoing.values_mut() {
        values.sort_by(|left, right| {
            left.successor_id
                .cmp(&right.successor_id)
                .then_with(|| left.lag_minutes.cmp(&right.lag_minutes))
        });
    }

    outgoing
}
