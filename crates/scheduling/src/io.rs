use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};

use engineo_project_model::{
    Activity, ActivityConstraint, ActivityKind, CalendarException, ConstraintType,
    ENGINE_CONTRACT_VERSION, LagCalendarPolicy, ProjectDefinition, ProjectFinishPolicy,
    Relationship, RelationshipType, ScheduleInput, ScheduleOptions, WbsNode, Weekday, WorkCalendar,
    WorkInterval,
};
use serde::{Deserialize, Serialize};

use crate::{ConstraintViolation, CpmResult, DrivingCause, ScheduleError, calculate_cpm};

#[derive(Debug)]
pub enum JsonBridgeError {
    Parse(serde_json::Error),
    UnsupportedSchemaVersion(u16),
    InvalidEnum { field: &'static str, value: String },
    Calculation(ScheduleError),
    Serialize(serde_json::Error),
}

impl Display for JsonBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(error) => write!(formatter, "invalid schedule JSON: {error}"),
            Self::UnsupportedSchemaVersion(version) => {
                write!(formatter, "unsupported schedule schema version: {version}")
            }
            Self::InvalidEnum { field, value } => {
                write!(formatter, "invalid {field} value: {value}")
            }
            Self::Calculation(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => write!(formatter, "failed to serialize CPM result: {error}"),
        }
    }
}

impl Error for JsonBridgeError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleInputDto {
    schema_version: u16,
    project: ProjectDto,
    schedule_options: ScheduleOptionsDto,
    calendars: Vec<CalendarDto>,
    wbs: Vec<WbsDto>,
    activities: Vec<ActivityDto>,
    relationships: Vec<RelationshipDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDto {
    id: String,
    name: String,
    planned_start: String,
    data_date: String,
    required_finish: Option<String>,
    default_calendar_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleOptionsDto {
    critical_float_threshold_minutes: u64,
    lag_calendar_policy: String,
    project_finish_policy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarDto {
    id: String,
    name: String,
    time_zone: String,
    week: BTreeMap<String, Vec<WorkIntervalDto>>,
    exceptions: Vec<CalendarExceptionDto>,
}

#[derive(Debug, Deserialize)]
struct WorkIntervalDto {
    start: String,
    end: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarExceptionDto {
    date: String,
    working_intervals: Vec<WorkIntervalDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WbsDto {
    id: String,
    parent_id: Option<String>,
    code: String,
    name: String,
    sort_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityDto {
    id: String,
    wbs_id: String,
    name: String,
    kind: String,
    duration_minutes: u32,
    calendar_id: String,
    constraints: Vec<ConstraintDto>,
}

#[derive(Debug, Deserialize)]
struct ConstraintDto {
    #[serde(rename = "type")]
    constraint_type: String,
    instant: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelationshipDto {
    predecessor_id: String,
    successor_id: String,
    #[serde(rename = "type")]
    relationship_type: String,
    lag_minutes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CpmResultDto {
    schema_version: u16,
    project_finish: String,
    late_project_finish: String,
    controlling_finish_activity: Option<String>,
    controlling_path: Vec<String>,
    activities: BTreeMap<String, ActivityResultDto>,
    constraint_violations: Vec<ConstraintViolationDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityResultDto {
    early_start: String,
    early_finish: String,
    late_start: String,
    late_finish: String,
    total_float_minutes: i64,
    free_float_minutes: i64,
    critical: bool,
    driving_causes: Vec<DrivingCauseDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DrivingCauseDto {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    predecessor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relationship_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lag_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraint_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instant: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConstraintViolationDto {
    activity_id: String,
    constraint_type: &'static str,
    constraint_instant: String,
    actual_instant: String,
}

pub fn calculate_schedule_json(input: &str) -> Result<String, JsonBridgeError> {
    let schedule = parse_schedule_json(input)?;
    let result = calculate_cpm(&schedule).map_err(JsonBridgeError::Calculation)?;
    let output = cpm_result_dto(&result);

    serde_json::to_string(&output).map_err(JsonBridgeError::Serialize)
}

pub fn parse_schedule_json(input: &str) -> Result<ScheduleInput, JsonBridgeError> {
    let dto: ScheduleInputDto = serde_json::from_str(input).map_err(JsonBridgeError::Parse)?;

    if dto.schema_version != ENGINE_CONTRACT_VERSION {
        return Err(JsonBridgeError::UnsupportedSchemaVersion(
            dto.schema_version,
        ));
    }

    Ok(ScheduleInput {
        schema_version: dto.schema_version,
        project: ProjectDefinition {
            id: dto.project.id,
            name: dto.project.name,
            planned_start_rfc3339: dto.project.planned_start,
            data_date_rfc3339: dto.project.data_date,
            required_finish_rfc3339: dto.project.required_finish,
            default_calendar_id: dto.project.default_calendar_id,
        },
        schedule_options: ScheduleOptions {
            critical_float_threshold_minutes: dto.schedule_options.critical_float_threshold_minutes,
            lag_calendar_policy: parse_lag_calendar_policy(
                &dto.schedule_options.lag_calendar_policy,
            )?,
            project_finish_policy: parse_project_finish_policy(
                &dto.schedule_options.project_finish_policy,
            )?,
        },
        calendars: dto
            .calendars
            .into_iter()
            .map(calendar_from_dto)
            .collect::<Result<Vec<_>, _>>()?,
        wbs: dto
            .wbs
            .into_iter()
            .map(|node| WbsNode {
                id: node.id,
                parent_id: node.parent_id,
                code: node.code,
                name: node.name,
                sort_order: node.sort_order,
            })
            .collect(),
        activities: dto
            .activities
            .into_iter()
            .map(activity_from_dto)
            .collect::<Result<Vec<_>, _>>()?,
        relationships: dto
            .relationships
            .into_iter()
            .map(relationship_from_dto)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn calendar_from_dto(dto: CalendarDto) -> Result<WorkCalendar, JsonBridgeError> {
    let mut week = Vec::with_capacity(dto.week.len());

    for (name, intervals) in dto.week {
        week.push((
            parse_weekday(&name)?,
            intervals
                .into_iter()
                .map(|interval| WorkInterval {
                    start_local_hhmm: interval.start,
                    end_local_hhmm: interval.end,
                })
                .collect(),
        ));
    }

    week.sort_by_key(|(weekday, _)| weekday_rank(*weekday));

    Ok(WorkCalendar {
        id: dto.id,
        name: dto.name,
        time_zone: dto.time_zone,
        week,
        exceptions: dto
            .exceptions
            .into_iter()
            .map(|exception| CalendarException {
                local_date: exception.date,
                working_intervals: exception
                    .working_intervals
                    .into_iter()
                    .map(|interval| WorkInterval {
                        start_local_hhmm: interval.start,
                        end_local_hhmm: interval.end,
                    })
                    .collect(),
            })
            .collect(),
    })
}

fn activity_from_dto(dto: ActivityDto) -> Result<Activity, JsonBridgeError> {
    Ok(Activity {
        id: dto.id,
        wbs_id: dto.wbs_id,
        name: dto.name,
        kind: parse_activity_kind(&dto.kind)?,
        duration_minutes: dto.duration_minutes,
        calendar_id: dto.calendar_id,
        constraints: dto
            .constraints
            .into_iter()
            .map(|constraint| {
                Ok(ActivityConstraint {
                    constraint_type: parse_constraint_type(&constraint.constraint_type)?,
                    instant_rfc3339: constraint.instant,
                })
            })
            .collect::<Result<Vec<_>, JsonBridgeError>>()?,
    })
}

fn relationship_from_dto(dto: RelationshipDto) -> Result<Relationship, JsonBridgeError> {
    Ok(Relationship {
        predecessor_id: dto.predecessor_id,
        successor_id: dto.successor_id,
        relationship_type: parse_relationship_type(&dto.relationship_type)?,
        lag_minutes: dto.lag_minutes,
    })
}

fn cpm_result_dto(result: &CpmResult) -> CpmResultDto {
    let activities = result
        .early
        .activities
        .iter()
        .map(|(activity_id, early)| {
            let late = result
                .late
                .get(activity_id)
                .expect("CPM result must contain late dates for every activity");

            (
                activity_id.clone(),
                ActivityResultDto {
                    early_start: early.early_start.to_rfc3339(),
                    early_finish: early.early_finish.to_rfc3339(),
                    late_start: late.late_start.to_rfc3339(),
                    late_finish: late.late_finish.to_rfc3339(),
                    total_float_minutes: late.total_float_minutes,
                    free_float_minutes: late.free_float_minutes,
                    critical: late.critical,
                    driving_causes: early.driving_causes.iter().map(driving_cause_dto).collect(),
                },
            )
        })
        .collect();

    CpmResultDto {
        schema_version: ENGINE_CONTRACT_VERSION,
        project_finish: result.early.project_finish.to_rfc3339(),
        late_project_finish: result.late_project_finish.to_rfc3339(),
        controlling_finish_activity: result.early.controlling_finish_activity.clone(),
        controlling_path: result.early.controlling_path.clone(),
        activities,
        constraint_violations: result
            .constraint_violations
            .iter()
            .map(constraint_violation_dto)
            .collect(),
    }
}

fn driving_cause_dto(cause: &DrivingCause) -> DrivingCauseDto {
    match cause {
        DrivingCause::ProjectStart => DrivingCauseDto {
            kind: "PROJECT_START",
            predecessor_id: None,
            relationship_type: None,
            lag_minutes: None,
            constraint_type: None,
            instant: None,
        },
        DrivingCause::Relationship {
            predecessor_id,
            relationship_type,
            lag_minutes,
        } => DrivingCauseDto {
            kind: "RELATIONSHIP",
            predecessor_id: Some(predecessor_id.clone()),
            relationship_type: Some(relationship_type_name(*relationship_type)),
            lag_minutes: Some(*lag_minutes),
            constraint_type: None,
            instant: None,
        },
        DrivingCause::Constraint {
            constraint_type,
            instant_rfc3339,
        } => DrivingCauseDto {
            kind: "CONSTRAINT",
            predecessor_id: None,
            relationship_type: None,
            lag_minutes: None,
            constraint_type: Some(constraint_type_name(*constraint_type)),
            instant: Some(instant_rfc3339.clone()),
        },
    }
}

fn constraint_violation_dto(violation: &ConstraintViolation) -> ConstraintViolationDto {
    ConstraintViolationDto {
        activity_id: violation.activity_id.clone(),
        constraint_type: constraint_type_name(violation.constraint_type),
        constraint_instant: violation.constraint_instant.to_rfc3339(),
        actual_instant: violation.actual_instant.to_rfc3339(),
    }
}

fn parse_weekday(value: &str) -> Result<Weekday, JsonBridgeError> {
    match value {
        "MONDAY" => Ok(Weekday::Monday),
        "TUESDAY" => Ok(Weekday::Tuesday),
        "WEDNESDAY" => Ok(Weekday::Wednesday),
        "THURSDAY" => Ok(Weekday::Thursday),
        "FRIDAY" => Ok(Weekday::Friday),
        "SATURDAY" => Ok(Weekday::Saturday),
        "SUNDAY" => Ok(Weekday::Sunday),
        _ => invalid_enum("weekday", value),
    }
}

fn parse_activity_kind(value: &str) -> Result<ActivityKind, JsonBridgeError> {
    match value {
        "TASK" => Ok(ActivityKind::Task),
        "START_MILESTONE" => Ok(ActivityKind::StartMilestone),
        "FINISH_MILESTONE" => Ok(ActivityKind::FinishMilestone),
        _ => invalid_enum("activity kind", value),
    }
}

fn parse_constraint_type(value: &str) -> Result<ConstraintType, JsonBridgeError> {
    match value {
        "START_ON_OR_AFTER" => Ok(ConstraintType::StartOnOrAfter),
        "START_ON_OR_BEFORE" => Ok(ConstraintType::StartOnOrBefore),
        "FINISH_ON_OR_AFTER" => Ok(ConstraintType::FinishOnOrAfter),
        "FINISH_ON_OR_BEFORE" => Ok(ConstraintType::FinishOnOrBefore),
        _ => invalid_enum("constraint type", value),
    }
}

fn parse_relationship_type(value: &str) -> Result<RelationshipType, JsonBridgeError> {
    match value {
        "FS" => Ok(RelationshipType::FinishToStart),
        "SS" => Ok(RelationshipType::StartToStart),
        "FF" => Ok(RelationshipType::FinishToFinish),
        "SF" => Ok(RelationshipType::StartToFinish),
        _ => invalid_enum("relationship type", value),
    }
}

fn parse_lag_calendar_policy(value: &str) -> Result<LagCalendarPolicy, JsonBridgeError> {
    match value {
        "PREDECESSOR" => Ok(LagCalendarPolicy::Predecessor),
        "SUCCESSOR" => Ok(LagCalendarPolicy::Successor),
        "PROJECT" => Ok(LagCalendarPolicy::Project),
        _ => invalid_enum("lag calendar policy", value),
    }
}

fn parse_project_finish_policy(value: &str) -> Result<ProjectFinishPolicy, JsonBridgeError> {
    match value {
        "CALCULATED" => Ok(ProjectFinishPolicy::Calculated),
        "REQUIRED_FINISH" => Ok(ProjectFinishPolicy::RequiredFinish),
        _ => invalid_enum("project finish policy", value),
    }
}

fn invalid_enum<T>(field: &'static str, value: &str) -> Result<T, JsonBridgeError> {
    Err(JsonBridgeError::InvalidEnum {
        field,
        value: value.to_owned(),
    })
}

const fn weekday_rank(value: Weekday) -> u8 {
    match value {
        Weekday::Monday => 0,
        Weekday::Tuesday => 1,
        Weekday::Wednesday => 2,
        Weekday::Thursday => 3,
        Weekday::Friday => 4,
        Weekday::Saturday => 5,
        Weekday::Sunday => 6,
    }
}

const fn relationship_type_name(value: RelationshipType) -> &'static str {
    match value {
        RelationshipType::FinishToStart => "FS",
        RelationshipType::StartToStart => "SS",
        RelationshipType::FinishToFinish => "FF",
        RelationshipType::StartToFinish => "SF",
    }
}

const fn constraint_type_name(value: ConstraintType) -> &'static str {
    match value {
        ConstraintType::StartOnOrAfter => "START_ON_OR_AFTER",
        ConstraintType::StartOnOrBefore => "START_ON_OR_BEFORE",
        ConstraintType::FinishOnOrAfter => "FINISH_ON_OR_AFTER",
        ConstraintType::FinishOnOrBefore => "FINISH_ON_OR_BEFORE",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{calculate_schedule_json, parse_schedule_json};

    const FIXTURE: &str = include_str!("../../../fixtures/contracts/v1/minimal-project.json");

    #[test]
    fn canonical_contract_fixture_parses() {
        let input = parse_schedule_json(FIXTURE).expect("fixture must parse");

        assert_eq!(input.schema_version, 1);
        assert_eq!(input.activities.len(), 2);
        assert_eq!(input.relationships.len(), 1);
    }

    #[test]
    fn canonical_contract_fixture_calculates_to_stable_json() {
        let output = calculate_schedule_json(FIXTURE).expect("fixture must calculate");
        let value: Value = serde_json::from_str(&output).expect("result must be JSON");

        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["controllingPath"].as_array().map(Vec::len), Some(2));
        assert!(value["activities"]["A110"]["earlyStart"].is_string());
        assert!(value["activities"]["A110"]["totalFloatMinutes"].is_i64());
    }
}
