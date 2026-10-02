#![forbid(unsafe_code)]

mod backward;
mod forward;
mod graph;

pub use backward::{CpmResult, LateDates, backward_pass, calculate_cpm};
pub use forward::{EarlyDates, ForwardPassResult, ScheduleError, forward_pass};
pub use graph::{GraphError, OpenEnds, ScheduleGraph};

use engineo_calendar::WorkMinutes;
use engineo_project_model::ENGINE_CONTRACT_VERSION;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineInfo {
    pub contract_version: u16,
    pub zero_work_duration: WorkMinutes,
}

#[must_use]
pub const fn engine_info() -> EngineInfo {
    EngineInfo {
        contract_version: ENGINE_CONTRACT_VERSION,
        zero_work_duration: WorkMinutes::ZERO,
    }
}

#[cfg(test)]
mod tests {
    use super::engine_info;

    #[test]
    fn engine_exposes_contract_version() {
        let info = engine_info();

        assert_eq!(info.contract_version, 1);
        assert_eq!(info.zero_work_duration.get(), 0);
    }
}
