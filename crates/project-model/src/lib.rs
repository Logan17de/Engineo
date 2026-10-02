#![forbid(unsafe_code)]

pub const ENGINE_CONTRACT_VERSION: u16 = 1;

pub type ProjectId = String;
pub type ActivityId = String;
pub type CalendarId = String;
pub type WbsId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkInterval {
    pub start_local_hhmm: String,
    pub end_local_hhmm: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarException {
    pub local_date: String,
    pub working_intervals: Vec<WorkInterval>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkCalendar {
    pub id: CalendarId,
    pub name: String,
    pub time_zone: String,
    pub week: Vec<(Weekday, Vec<WorkInterval>)>,
    pub exceptions: Vec<CalendarException>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WbsNode {
    pub id: WbsId,
    pub parent_id: Option<WbsId>,
    pub code: String,
    pub name: String,
    pub sort_order: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActivityKind {
    Task,
    StartMilestone,
    FinishMilestone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConstraintType {
    StartOnOrAfter,
    StartOnOrBefore,
    FinishOnOrAfter,
    FinishOnOrBefore,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityConstraint {
    pub constraint_type: ConstraintType,
    pub instant_rfc3339: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub id: ActivityId,
    pub wbs_id: WbsId,
    pub name: String,
    pub kind: ActivityKind,
    pub duration_minutes: u32,
    pub calendar_id: CalendarId,
    pub constraints: Vec<ActivityConstraint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RelationshipType {
    FinishToStart,
    StartToStart,
    FinishToFinish,
    StartToFinish,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relationship {
    pub predecessor_id: ActivityId,
    pub successor_id: ActivityId,
    pub relationship_type: RelationshipType,
    pub lag_minutes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LagCalendarPolicy {
    Predecessor,
    Successor,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectFinishPolicy {
    Calculated,
    RequiredFinish,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleOptions {
    pub critical_float_threshold_minutes: u64,
    pub lag_calendar_policy: LagCalendarPolicy,
    pub project_finish_policy: ProjectFinishPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDefinition {
    pub id: ProjectId,
    pub name: String,
    pub planned_start_rfc3339: String,
    pub data_date_rfc3339: String,
    pub required_finish_rfc3339: Option<String>,
    pub default_calendar_id: CalendarId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleInput {
    pub schema_version: u16,
    pub project: ProjectDefinition,
    pub schedule_options: ScheduleOptions,
    pub calendars: Vec<WorkCalendar>,
    pub wbs: Vec<WbsNode>,
    pub activities: Vec<Activity>,
    pub relationships: Vec<Relationship>,
}

#[cfg(test)]
mod tests {
    use super::{
        ActivityKind, ENGINE_CONTRACT_VERSION, LagCalendarPolicy, ProjectFinishPolicy,
        RelationshipType,
    };

    #[test]
    fn contract_version_starts_at_one() {
        assert_eq!(ENGINE_CONTRACT_VERSION, 1);
    }

    #[test]
    fn scheduling_enums_are_explicit() {
        assert_ne!(ActivityKind::Task, ActivityKind::StartMilestone);
        assert_ne!(RelationshipType::FinishToStart, RelationshipType::StartToStart);
        assert_ne!(LagCalendarPolicy::Project, LagCalendarPolicy::Successor);
        assert_ne!(ProjectFinishPolicy::Calculated, ProjectFinishPolicy::RequiredFinish);
    }
}
