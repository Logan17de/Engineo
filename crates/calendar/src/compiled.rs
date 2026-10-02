use std::collections::BTreeMap;
use std::str::FromStr;

use chrono::{
    DateTime, Datelike, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeDelta, TimeZone, Utc,
};
use chrono_tz::Tz;
use engineo_project_model::{Weekday, WorkCalendar, WorkInterval};

use crate::{CalendarError, WorkMinutes};

const MAX_SEARCH_DAYS: usize = 36_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalInterval {
    start: NaiveTime,
    end: NaiveTime,
}

#[derive(Debug, Clone, Copy)]
enum Boundary {
    Start,
    End,
}

#[derive(Debug, Clone)]
pub struct CompiledCalendar {
    time_zone: Tz,
    week: [Vec<LocalInterval>; 7],
    exceptions: BTreeMap<NaiveDate, Vec<LocalInterval>>,
}

impl CompiledCalendar {
    pub fn compile(calendar: &WorkCalendar) -> Result<Self, CalendarError> {
        let time_zone = Tz::from_str(&calendar.time_zone)
            .map_err(|_| CalendarError::InvalidTimeZone(calendar.time_zone.clone()))?;

        let mut week: [Vec<LocalInterval>; 7] = std::array::from_fn(|_| Vec::new());
        let mut seen_weekdays = [false; 7];

        for (weekday, intervals) in &calendar.week {
            let index = weekday_index(*weekday);
            if seen_weekdays[index] {
                return Err(CalendarError::DuplicateWeekday);
            }
            seen_weekdays[index] = true;
            week[index] = compile_intervals(intervals)?;
        }

        let mut exceptions = BTreeMap::new();
        for exception in &calendar.exceptions {
            let date = NaiveDate::parse_from_str(&exception.local_date, "%Y-%m-%d")
                .map_err(|_| CalendarError::InvalidDate(exception.local_date.clone()))?;
            let intervals = compile_intervals(&exception.working_intervals)?;

            if exceptions.insert(date, intervals).is_some() {
                return Err(CalendarError::DuplicateExceptionDate(
                    exception.local_date.clone(),
                ));
            }
        }

        Ok(Self {
            time_zone,
            week,
            exceptions,
        })
    }

    #[must_use]
    pub const fn time_zone(&self) -> Tz {
        self.time_zone
    }

    pub fn next_work_instant(
        &self,
        instant: DateTime<Utc>,
    ) -> Result<DateTime<Utc>, CalendarError> {
        let mut date = instant.with_timezone(&self.time_zone).date_naive();

        for _ in 0..MAX_SEARCH_DAYS {
            for interval in self.intervals_for_date(date) {
                let (start, end) = self.interval_bounds(date, *interval)?;

                if instant < start {
                    return Ok(start);
                }
                if instant >= start && instant < end {
                    return Ok(instant);
                }
            }

            date = date.succ_opt().ok_or(CalendarError::DateOutOfRange)?;
        }

        Err(CalendarError::NoWorkingTime)
    }

    pub fn previous_work_instant(
        &self,
        instant: DateTime<Utc>,
    ) -> Result<DateTime<Utc>, CalendarError> {
        let mut date = instant.with_timezone(&self.time_zone).date_naive();

        for _ in 0..MAX_SEARCH_DAYS {
            for interval in self.intervals_for_date(date).iter().rev() {
                let (start, end) = self.interval_bounds(date, *interval)?;

                if instant > end {
                    return Ok(end);
                }
                if instant > start && instant <= end {
                    return Ok(instant);
                }
            }

            date = date.pred_opt().ok_or(CalendarError::DateOutOfRange)?;
        }

        Err(CalendarError::NoWorkingTime)
    }

    pub fn add_work_duration(
        &self,
        instant: DateTime<Utc>,
        duration: WorkMinutes,
    ) -> Result<DateTime<Utc>, CalendarError> {
        let mut current = self.next_work_instant(instant)?;
        let mut remaining_seconds = i64::from(duration.get()) * 60;

        while remaining_seconds > 0 {
            let end = self
                .containing_interval_end(current)?
                .ok_or(CalendarError::NoWorkingTime)?;
            let available_seconds = (end - current).num_seconds();

            if remaining_seconds <= available_seconds {
                let delta = TimeDelta::try_seconds(remaining_seconds)
                    .ok_or(CalendarError::DurationOutOfRange)?;
                return current
                    .checked_add_signed(delta)
                    .ok_or(CalendarError::DateOutOfRange);
            }

            remaining_seconds -= available_seconds;
            current = self.next_work_instant(end)?;
        }

        Ok(current)
    }

    pub fn subtract_work_duration(
        &self,
        instant: DateTime<Utc>,
        duration: WorkMinutes,
    ) -> Result<DateTime<Utc>, CalendarError> {
        let mut current = self.previous_work_instant(instant)?;
        let mut remaining_seconds = i64::from(duration.get()) * 60;

        while remaining_seconds > 0 {
            let start = self
                .containing_interval_start(current)?
                .ok_or(CalendarError::NoWorkingTime)?;
            let available_seconds = (current - start).num_seconds();

            if remaining_seconds <= available_seconds {
                let delta = TimeDelta::try_seconds(remaining_seconds)
                    .ok_or(CalendarError::DurationOutOfRange)?;
                return current
                    .checked_sub_signed(delta)
                    .ok_or(CalendarError::DateOutOfRange);
            }

            remaining_seconds -= available_seconds;
            current = self.previous_work_instant(start)?;
        }

        Ok(current)
    }

    pub fn working_minutes_between(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<i64, CalendarError> {
        if start == end {
            return Ok(0);
        }
        if start > end {
            return self
                .working_minutes_between(end, start)
                .map(std::ops::Neg::neg);
        }

        let first_date = start.with_timezone(&self.time_zone).date_naive();
        let last_date = end.with_timezone(&self.time_zone).date_naive();
        let mut date = first_date;
        let mut total_seconds = 0_i64;

        loop {
            for interval in self.intervals_for_date(date) {
                let (interval_start, interval_end) = self.interval_bounds(date, *interval)?;
                let overlap_start = start.max(interval_start);
                let overlap_end = end.min(interval_end);

                if overlap_start < overlap_end {
                    total_seconds = total_seconds
                        .checked_add((overlap_end - overlap_start).num_seconds())
                        .ok_or(CalendarError::DurationOutOfRange)?;
                }
            }

            if date == last_date {
                break;
            }
            date = date.succ_opt().ok_or(CalendarError::DateOutOfRange)?;
        }

        Ok(total_seconds / 60)
    }

    fn intervals_for_date(&self, date: NaiveDate) -> &[LocalInterval] {
        self.exceptions.get(&date).map_or_else(
            || self.week[chrono_weekday_index(date.weekday())].as_slice(),
            Vec::as_slice,
        )
    }

    fn interval_bounds(
        &self,
        date: NaiveDate,
        interval: LocalInterval,
    ) -> Result<(DateTime<Utc>, DateTime<Utc>), CalendarError> {
        let start = self.resolve_local(date.and_time(interval.start), Boundary::Start)?;
        let end = self.resolve_local(date.and_time(interval.end), Boundary::End)?;

        if start >= end {
            return Err(CalendarError::InvalidInterval {
                start: interval.start.format("%H:%M").to_string(),
                end: interval.end.format("%H:%M").to_string(),
            });
        }

        Ok((start, end))
    }

    fn resolve_local(
        &self,
        local: NaiveDateTime,
        boundary: Boundary,
    ) -> Result<DateTime<Utc>, CalendarError> {
        match self.time_zone.from_local_datetime(&local) {
            LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
            LocalResult::Ambiguous(first, second) => {
                let first = first.with_timezone(&Utc);
                let second = second.with_timezone(&Utc);
                match boundary {
                    Boundary::Start => Ok(first.min(second)),
                    Boundary::End => Ok(first.max(second)),
                }
            }
            LocalResult::None => Err(CalendarError::NonexistentLocalBoundary(
                local.format("%Y-%m-%dT%H:%M").to_string(),
            )),
        }
    }

    fn containing_interval_end(
        &self,
        instant: DateTime<Utc>,
    ) -> Result<Option<DateTime<Utc>>, CalendarError> {
        let date = instant.with_timezone(&self.time_zone).date_naive();
        for interval in self.intervals_for_date(date) {
            let (start, end) = self.interval_bounds(date, *interval)?;
            if instant >= start && instant < end {
                return Ok(Some(end));
            }
        }
        Ok(None)
    }

    fn containing_interval_start(
        &self,
        instant: DateTime<Utc>,
    ) -> Result<Option<DateTime<Utc>>, CalendarError> {
        let date = instant.with_timezone(&self.time_zone).date_naive();
        for interval in self.intervals_for_date(date) {
            let (start, end) = self.interval_bounds(date, *interval)?;
            if instant > start && instant <= end {
                return Ok(Some(start));
            }
        }
        Ok(None)
    }
}

fn compile_intervals(intervals: &[WorkInterval]) -> Result<Vec<LocalInterval>, CalendarError> {
    let mut compiled = intervals
        .iter()
        .map(|interval| {
            let start = NaiveTime::parse_from_str(&interval.start_local_hhmm, "%H:%M")
                .map_err(|_| CalendarError::InvalidTime(interval.start_local_hhmm.clone()))?;
            let end = NaiveTime::parse_from_str(&interval.end_local_hhmm, "%H:%M")
                .map_err(|_| CalendarError::InvalidTime(interval.end_local_hhmm.clone()))?;

            if start >= end {
                return Err(CalendarError::InvalidInterval {
                    start: interval.start_local_hhmm.clone(),
                    end: interval.end_local_hhmm.clone(),
                });
            }

            Ok(LocalInterval { start, end })
        })
        .collect::<Result<Vec<_>, _>>()?;

    compiled.sort_unstable_by_key(|interval| interval.start);

    for pair in compiled.windows(2) {
        if pair[0].end > pair[1].start {
            return Err(CalendarError::OverlappingIntervals);
        }
    }

    Ok(compiled)
}

const fn weekday_index(weekday: Weekday) -> usize {
    match weekday {
        Weekday::Monday => 0,
        Weekday::Tuesday => 1,
        Weekday::Wednesday => 2,
        Weekday::Thursday => 3,
        Weekday::Friday => 4,
        Weekday::Saturday => 5,
        Weekday::Sunday => 6,
    }
}

const fn chrono_weekday_index(weekday: chrono::Weekday) -> usize {
    match weekday {
        chrono::Weekday::Mon => 0,
        chrono::Weekday::Tue => 1,
        chrono::Weekday::Wed => 2,
        chrono::Weekday::Thu => 3,
        chrono::Weekday::Fri => 4,
        chrono::Weekday::Sat => 5,
        chrono::Weekday::Sun => 6,
    }
}
