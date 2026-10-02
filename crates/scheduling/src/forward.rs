use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};

use chrono::{DateTime, Utc};
use engineo_calendar::{CalendarError, CompiledCalendar, WorkMinutes};
use engineo_project_model::{
    Activity, ActivityId, CalendarId, LagCalendarPolicy, Relationship, RelationshipType,
    ScheduleInput,
};

use crate::{GraphError, ScheduleGraph};

#[derive(Debug)]
pub enum ScheduleError {
    Graph(GraphError),
    Calendar(CalendarError),
    DuplicateCalendar(CalendarId),
    MissingCalendar(CalendarId),
    MissingActivity(ActivityId),
    MissingPredecessorDates(ActivityId),
    MissingSuccessorDates(ActivityId),
    InvalidProjectStart(String),
    InvalidRequiredFinish(String),
    LagOutOfRange(i64),
}

impl Display for ScheduleError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Graph(error) => write!(formatter, "{error}"),
            Self::Calendar(error) => write!(formatter, "{error}"),
            Self::DuplicateCalendar(id) => write!(formatter, "duplicate calendar ID: {id}"),
            Self::MissingCalendar(id) => write!(formatter, "unknown calendar: {id}"),
            Self::MissingActivity(id) => write!(formatter, "unknown activity: {id}"),
            Self::MissingPredecessorDates(id) => {
                write!(formatter, "predecessor has no calculated early dates: {id}")
            }
            Self::MissingSuccessorDates(id) => {
                write!(formatter, "successor has no calculated late dates: {id}")
            }
            Self::InvalidProjectStart(value) => {
                write!(formatter, "invalid RFC 3339 project start: {value}")
            }
            Self::InvalidRequiredFinish(value) => {
                write!(formatter, "invalid RFC 3339 required finish: {value}")
            }
            Self::LagOutOfRange(value) => {
                write!(
                    formatter,
                    "relationship lag is outside supported range: {value}"
                )
            }
        }
    }
}

impl Error for ScheduleError {}

impl From<GraphError> for ScheduleError {
    fn from(value: GraphError) -> Self {
        Self::Graph(value)
    }
}

impl From<CalendarError> for ScheduleError {
    fn from(value: CalendarError) -> Self {
        Self::Calendar(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarlyDates {
    pub activity_id: ActivityId,
    pub early_start: DateTime<Utc>,
    pub early_finish: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardPassResult {
    pub activities: BTreeMap<ActivityId, EarlyDates>,
    pub project_finish: DateTime<Utc>,
}

impl ForwardPassResult {
    #[must_use]
    pub fn activity(&self, activity_id: &str) -> Option<&EarlyDates> {
        self.activities.get(activity_id)
    }
}

pub fn forward_pass(input: &ScheduleInput) -> Result<ForwardPassResult, ScheduleError> {
    let graph = ScheduleGraph::build(&input.activities, &input.relationships)?;
    let calendars = compile_calendars(input)?;
    let activities = input
        .activities
        .iter()
        .map(|activity| (activity.id.as_str(), activity))
        .collect::<BTreeMap<_, _>>();
    let incoming = incoming_relationships(&input.relationships);

    let project_start = DateTime::parse_from_rfc3339(&input.project.planned_start_rfc3339)
        .map_err(|_| {
            ScheduleError::InvalidProjectStart(input.project.planned_start_rfc3339.clone())
        })?
        .with_timezone(&Utc);

    let project_calendar = calendars
        .get(&input.project.default_calendar_id)
        .ok_or_else(|| ScheduleError::MissingCalendar(input.project.default_calendar_id.clone()))?;

    let mut calculated = BTreeMap::<ActivityId, EarlyDates>::new();

    for activity_id in graph.topological_activity_ids() {
        let activity = activities
            .get(activity_id)
            .copied()
            .ok_or_else(|| ScheduleError::MissingActivity(activity_id.to_owned()))?;
        let activity_calendar = calendars
            .get(&activity.calendar_id)
            .ok_or_else(|| ScheduleError::MissingCalendar(activity.calendar_id.clone()))?;

        let mut early_start = activity_calendar.next_work_instant(project_start)?;

        if let Some(relationships) = incoming.get(activity_id) {
            for relationship in relationships {
                let predecessor = activities
                    .get(relationship.predecessor_id.as_str())
                    .copied()
                    .ok_or_else(|| {
                        ScheduleError::MissingActivity(relationship.predecessor_id.clone())
                    })?;
                let predecessor_dates =
                    calculated
                        .get(&relationship.predecessor_id)
                        .ok_or_else(|| {
                            ScheduleError::MissingPredecessorDates(
                                relationship.predecessor_id.clone(),
                            )
                        })?;

                let lag_calendar = lag_calendar(
                    input.schedule_options.lag_calendar_policy,
                    predecessor,
                    activity,
                    project_calendar,
                    &calendars,
                )?;

                let candidate = relationship_start_bound(
                    relationship,
                    predecessor_dates,
                    activity,
                    activity_calendar,
                    lag_calendar,
                )?;

                early_start = early_start.max(candidate);
            }
        }

        early_start = activity_calendar.next_work_instant(early_start)?;
        let early_finish = activity_calendar
            .add_work_duration(early_start, WorkMinutes::new(activity.duration_minutes))?;

        calculated.insert(
            activity.id.clone(),
            EarlyDates {
                activity_id: activity.id.clone(),
                early_start,
                early_finish,
            },
        );
    }

    let project_finish = calculated
        .values()
        .map(|dates| dates.early_finish)
        .max()
        .unwrap_or(project_start);

    Ok(ForwardPassResult {
        activities: calculated,
        project_finish,
    })
}

pub(crate) fn compile_calendars(
    input: &ScheduleInput,
) -> Result<BTreeMap<CalendarId, CompiledCalendar>, ScheduleError> {
    let mut calendars = BTreeMap::new();

    for calendar in &input.calendars {
        if calendars.contains_key(&calendar.id) {
            return Err(ScheduleError::DuplicateCalendar(calendar.id.clone()));
        }

        calendars.insert(calendar.id.clone(), CompiledCalendar::compile(calendar)?);
    }

    Ok(calendars)
}

fn incoming_relationships(relationships: &[Relationship]) -> BTreeMap<&str, Vec<&Relationship>> {
    let mut incoming = BTreeMap::<&str, Vec<&Relationship>>::new();

    for relationship in relationships {
        incoming
            .entry(relationship.successor_id.as_str())
            .or_default()
            .push(relationship);
    }

    for values in incoming.values_mut() {
        values.sort_by(|left, right| {
            left.predecessor_id
                .cmp(&right.predecessor_id)
                .then_with(|| {
                    relationship_rank(left.relationship_type)
                        .cmp(&relationship_rank(right.relationship_type))
                })
                .then_with(|| left.lag_minutes.cmp(&right.lag_minutes))
        });
    }

    incoming
}

pub(crate) fn lag_calendar<'a>(
    policy: LagCalendarPolicy,
    predecessor: &Activity,
    successor: &Activity,
    project_calendar: &'a CompiledCalendar,
    calendars: &'a BTreeMap<CalendarId, CompiledCalendar>,
) -> Result<&'a CompiledCalendar, ScheduleError> {
    match policy {
        LagCalendarPolicy::Predecessor => calendars
            .get(&predecessor.calendar_id)
            .ok_or_else(|| ScheduleError::MissingCalendar(predecessor.calendar_id.clone())),
        LagCalendarPolicy::Successor => calendars
            .get(&successor.calendar_id)
            .ok_or_else(|| ScheduleError::MissingCalendar(successor.calendar_id.clone())),
        LagCalendarPolicy::Project => Ok(project_calendar),
    }
}

fn relationship_start_bound(
    relationship: &Relationship,
    predecessor: &EarlyDates,
    successor: &Activity,
    successor_calendar: &CompiledCalendar,
    lag_calendar: &CompiledCalendar,
) -> Result<DateTime<Utc>, ScheduleError> {
    let anchor = match relationship.relationship_type {
        RelationshipType::FinishToStart | RelationshipType::FinishToFinish => {
            predecessor.early_finish
        }
        RelationshipType::StartToStart | RelationshipType::StartToFinish => predecessor.early_start,
    };

    let lagged = shift_by_lag(lag_calendar, anchor, relationship.lag_minutes)?;

    match relationship.relationship_type {
        RelationshipType::FinishToStart | RelationshipType::StartToStart => {
            Ok(successor_calendar.next_work_instant(lagged)?)
        }
        RelationshipType::FinishToFinish | RelationshipType::StartToFinish => {
            finish_bound_to_start(successor_calendar, lagged, successor.duration_minutes)
        }
    }
}

fn finish_bound_to_start(
    calendar: &CompiledCalendar,
    finish_bound: DateTime<Utc>,
    duration_minutes: u32,
) -> Result<DateTime<Utc>, ScheduleError> {
    if duration_minutes == 0 {
        return Ok(calendar.next_work_instant(finish_bound)?);
    }

    let duration = WorkMinutes::new(duration_minutes);
    let candidate = calendar.subtract_work_duration(finish_bound, duration)?;
    let candidate = calendar.next_work_instant(candidate)?;
    let candidate_finish = calendar.add_work_duration(candidate, duration)?;

    if candidate_finish >= finish_bound {
        return Ok(candidate);
    }

    Ok(calendar.next_work_instant(finish_bound)?)
}

pub(crate) fn shift_by_lag(
    calendar: &CompiledCalendar,
    anchor: DateTime<Utc>,
    lag_minutes: i64,
) -> Result<DateTime<Utc>, ScheduleError> {
    if lag_minutes >= 0 {
        let minutes =
            u32::try_from(lag_minutes).map_err(|_| ScheduleError::LagOutOfRange(lag_minutes))?;
        return Ok(calendar.add_work_duration(anchor, WorkMinutes::new(minutes))?);
    }

    let magnitude = lag_minutes
        .checked_abs()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ScheduleError::LagOutOfRange(lag_minutes))?;

    Ok(calendar.subtract_work_duration(anchor, WorkMinutes::new(magnitude))?)
}

const fn relationship_rank(relationship_type: RelationshipType) -> u8 {
    match relationship_type {
        RelationshipType::FinishToStart => 0,
        RelationshipType::StartToStart => 1,
        RelationshipType::FinishToFinish => 2,
        RelationshipType::StartToFinish => 3,
    }
}
