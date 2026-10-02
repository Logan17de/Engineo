#![forbid(unsafe_code)]

mod compiled;
mod error;

pub use compiled::CompiledCalendar;
pub use error::CalendarError;

/// Versioned with the engine's pinned chrono-tz data, for boundary validation.
pub fn supported_time_zones() -> impl Iterator<Item = &'static str> {
    chrono_tz::TZ_VARIANTS
        .iter()
        .copied()
        .map(chrono_tz::Tz::name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorkMinutes(u32);

impl WorkMinutes {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}
