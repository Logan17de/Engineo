use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalendarError {
    InvalidTimeZone(String),
    InvalidDate(String),
    InvalidTime(String),
    InvalidInterval { start: String, end: String },
    OverlappingIntervals,
    DuplicateWeekday,
    DuplicateExceptionDate(String),
    NonexistentLocalBoundary(String),
    DateOutOfRange,
    NoWorkingTime,
    DurationOutOfRange,
}

impl Display for CalendarError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTimeZone(value) => write!(formatter, "invalid IANA time zone: {value}"),
            Self::InvalidDate(value) => write!(formatter, "invalid calendar date: {value}"),
            Self::InvalidTime(value) => write!(formatter, "invalid local time: {value}"),
            Self::InvalidInterval { start, end } => {
                write!(formatter, "invalid work interval: {start}-{end}")
            }
            Self::OverlappingIntervals => write!(formatter, "work intervals overlap"),
            Self::DuplicateWeekday => write!(formatter, "calendar contains a duplicate weekday"),
            Self::DuplicateExceptionDate(value) => {
                write!(formatter, "calendar contains duplicate exception date: {value}")
            }
            Self::NonexistentLocalBoundary(value) => {
                write!(formatter, "calendar boundary does not exist in its time zone: {value}")
            }
            Self::DateOutOfRange => {
                write!(formatter, "calendar date arithmetic exceeded supported range")
            }
            Self::NoWorkingTime => write!(formatter, "no working time found within search horizon"),
            Self::DurationOutOfRange => write!(formatter, "working duration exceeded supported range"),
        }
    }
}

impl Error for CalendarError {}
