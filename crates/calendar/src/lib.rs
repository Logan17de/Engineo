#![forbid(unsafe_code)]

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

#[cfg(test)]
mod tests {
    use super::WorkMinutes;

    #[test]
    fn work_minutes_preserve_value() {
        let duration = WorkMinutes::new(480);

        assert_eq!(duration.get(), 480);
        assert!(duration > WorkMinutes::ZERO);
    }
}
