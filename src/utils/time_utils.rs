//! Port of `src/utils/time-utils.ts`.

use chrono::{DateTime, Local};

/// Local calendar time as `YYYY-MM-DD HH:MM:SS`.
pub fn format_time(date: DateTime<Local>) -> String {
    date.format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::format_time;
    use chrono::{Local, TimeZone};

    #[test]
    fn formats_local_calendar_fields() {
        let date = Local
            .with_ymd_and_hms(2026, 10, 22, 16, 6, 5)
            .single()
            .unwrap();
        assert_eq!(format_time(date), "2026-10-22 16:06:05");
    }
}
