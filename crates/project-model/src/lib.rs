#![forbid(unsafe_code)]

pub const ENGINE_CONTRACT_VERSION: u16 = 1;

pub type ProjectId = String;
pub type ActivityId = String;
pub type CalendarId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RelationshipType {
    FinishToStart,
    StartToStart,
    FinishToFinish,
    StartToFinish,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub id: ActivityId,
    pub name: String,
    pub duration_minutes: u32,
    pub calendar_id: CalendarId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relationship {
    pub predecessor_id: ActivityId,
    pub successor_id: ActivityId,
    pub relationship_type: RelationshipType,
    pub lag_minutes: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub planned_start_iso: String,
    pub default_calendar_id: CalendarId,
    pub activities: Vec<Activity>,
    pub relationships: Vec<Relationship>,
}

#[cfg(test)]
mod tests {
    use super::ENGINE_CONTRACT_VERSION;

    #[test]
    fn contract_version_starts_at_one() {
        assert_eq!(ENGINE_CONTRACT_VERSION, 1);
    }
}
