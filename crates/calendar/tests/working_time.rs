use chrono::{DateTime, Utc};
use engineo_calendar::{CalendarError, CompiledCalendar, WorkMinutes};
use engineo_project_model::{CalendarException, Weekday, WorkCalendar, WorkInterval};

fn interval(start: &str, end: &str) -> WorkInterval {
    WorkInterval {
        start_local_hhmm: start.to_owned(),
        end_local_hhmm: end.to_owned(),
    }
}

fn standard_calendar(time_zone: &str) -> WorkCalendar {
    let workday = vec![interval("08:00", "12:00"), interval("13:00", "17:00")];

    WorkCalendar {
        id: "standard".to_owned(),
        name: "Standard".to_owned(),
        time_zone: time_zone.to_owned(),
        week: vec![
            (Weekday::Monday, workday.clone()),
            (Weekday::Tuesday, workday.clone()),
            (Weekday::Wednesday, workday.clone()),
            (Weekday::Thursday, workday.clone()),
            (Weekday::Friday, workday),
            (Weekday::Saturday, Vec::new()),
            (Weekday::Sunday, Vec::new()),
        ],
        exceptions: Vec::new(),
    }
}

fn utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("test timestamp must be valid")
        .with_timezone(&Utc)
}

#[test]
fn work_minutes_preserve_value() {
    let duration = WorkMinutes::new(480);

    assert_eq!(duration.get(), 480);
    assert!(duration > WorkMinutes::ZERO);
}

#[test]
fn next_work_instant_skips_lunch_and_weekend() {
    let calendar =
        CompiledCalendar::compile(&standard_calendar("Asia/Tokyo")).expect("calendar compiles");

    assert_eq!(
        calendar
            .next_work_instant(utc("2026-10-05T03:30:00Z"))
            .expect("next work exists"),
        utc("2026-10-05T04:00:00Z")
    );
    assert_eq!(
        calendar
            .next_work_instant(utc("2026-10-09T09:00:00Z"))
            .expect("next work exists"),
        utc("2026-10-11T23:00:00Z")
    );
}

#[test]
fn previous_work_instant_skips_lunch_and_weekend() {
    let calendar =
        CompiledCalendar::compile(&standard_calendar("Asia/Tokyo")).expect("calendar compiles");

    assert_eq!(
        calendar
            .previous_work_instant(utc("2026-10-05T03:30:00Z"))
            .expect("previous work exists"),
        utc("2026-10-05T03:00:00Z")
    );
    assert_eq!(
        calendar
            .previous_work_instant(utc("2026-10-11T22:00:00Z"))
            .expect("previous work exists"),
        utc("2026-10-09T08:00:00Z")
    );
}

#[test]
fn add_and_subtract_work_duration_cross_breaks_and_days() {
    let calendar =
        CompiledCalendar::compile(&standard_calendar("Asia/Tokyo")).expect("calendar compiles");

    let finish = calendar
        .add_work_duration(utc("2026-10-05T02:00:00Z"), WorkMinutes::new(600))
        .expect("duration can be added");
    assert_eq!(finish, utc("2026-10-06T05:00:00Z"));

    let start = calendar
        .subtract_work_duration(finish, WorkMinutes::new(600))
        .expect("duration can be subtracted");
    assert_eq!(start, utc("2026-10-05T02:00:00Z"));
}

#[test]
fn exception_replaces_recurring_workday() {
    let mut definition = standard_calendar("Asia/Tokyo");
    definition.exceptions.push(CalendarException {
        local_date: "2026-10-06".to_owned(),
        working_intervals: Vec::new(),
    });
    let calendar = CompiledCalendar::compile(&definition).expect("calendar compiles");

    let finish = calendar
        .add_work_duration(utc("2026-10-05T07:00:00Z"), WorkMinutes::new(120))
        .expect("duration can be added");

    assert_eq!(finish, utc("2026-10-07T00:00:00Z"));
}

#[test]
fn exception_can_define_special_shift() {
    let mut definition = standard_calendar("Asia/Tokyo");
    definition.exceptions.push(CalendarException {
        local_date: "2026-10-10".to_owned(),
        working_intervals: vec![interval("09:00", "12:00")],
    });
    let calendar = CompiledCalendar::compile(&definition).expect("calendar compiles");

    assert_eq!(
        calendar
            .next_work_instant(utc("2026-10-09T09:00:00Z"))
            .expect("special shift exists"),
        utc("2026-10-10T00:00:00Z")
    );
}

#[test]
fn working_minutes_between_is_signed_and_calendar_aware() {
    let calendar =
        CompiledCalendar::compile(&standard_calendar("Asia/Tokyo")).expect("calendar compiles");

    let start = utc("2026-10-05T00:00:00Z");
    let end = utc("2026-10-06T05:00:00Z");

    assert_eq!(
        calendar
            .working_minutes_between(start, end)
            .expect("duration calculates"),
        720
    );
    assert_eq!(
        calendar
            .working_minutes_between(end, start)
            .expect("reverse duration calculates"),
        -720
    );
}

#[test]
fn spring_dst_transition_uses_real_elapsed_working_time() {
    let definition = WorkCalendar {
        id: "london-spring".to_owned(),
        name: "London DST".to_owned(),
        time_zone: "Europe/London".to_owned(),
        week: vec![(Weekday::Sunday, vec![interval("00:00", "04:00")])],
        exceptions: Vec::new(),
    };
    let calendar = CompiledCalendar::compile(&definition).expect("calendar compiles");

    assert_eq!(
        calendar
            .working_minutes_between(
                utc("2026-03-29T00:00:00Z"),
                utc("2026-03-29T03:00:00Z"),
            )
            .expect("duration calculates"),
        180
    );
    assert_eq!(
        calendar
            .add_work_duration(
                utc("2026-03-29T00:00:00Z"),
                WorkMinutes::new(180),
            )
            .expect("duration can be added"),
        utc("2026-03-29T03:00:00Z")
    );
}

#[test]
fn fall_dst_transition_counts_repeated_hour_once_per_real_hour() {
    let definition = WorkCalendar {
        id: "london-fall".to_owned(),
        name: "London DST".to_owned(),
        time_zone: "Europe/London".to_owned(),
        week: vec![(Weekday::Sunday, vec![interval("00:00", "04:00")])],
        exceptions: Vec::new(),
    };
    let calendar = CompiledCalendar::compile(&definition).expect("calendar compiles");

    assert_eq!(
        calendar
            .working_minutes_between(
                utc("2026-10-24T23:00:00Z"),
                utc("2026-10-25T04:00:00Z"),
            )
            .expect("duration calculates"),
        300
    );
}

#[test]
fn nonexistent_dst_boundary_is_rejected_explicitly() {
    let definition = WorkCalendar {
        id: "bad-dst-boundary".to_owned(),
        name: "Bad DST boundary".to_owned(),
        time_zone: "Europe/London".to_owned(),
        week: Vec::new(),
        exceptions: vec![CalendarException {
            local_date: "2026-03-29".to_owned(),
            working_intervals: vec![interval("01:30", "03:00")],
        }],
    };
    let calendar = CompiledCalendar::compile(&definition).expect("shape compiles");

    let error = calendar
        .next_work_instant(utc("2026-03-29T00:00:00Z"))
        .expect_err("nonexistent local boundary must fail");

    assert!(matches!(error, CalendarError::NonexistentLocalBoundary(_)));
}

#[test]
fn invalid_intervals_fail_during_compilation() {
    let mut definition = standard_calendar("UTC");
    definition.week = vec![(
        Weekday::Monday,
        vec![interval("08:00", "12:00"), interval("11:00", "13:00")],
    )];

    assert_eq!(
        CompiledCalendar::compile(&definition).expect_err("overlap must fail"),
        CalendarError::OverlappingIntervals
    );
}
