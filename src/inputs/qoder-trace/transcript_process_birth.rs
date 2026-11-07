//! Single-PID birth metadata: no process-list enumeration, argv or environment.
#[cfg(target_os = "linux")]
pub(super) fn birth_ms(pid: u32) -> Option<f64> {
    use std::io::Read;
    if pid == 0 {
        return None;
    }
    let mut bytes = Vec::new();
    crate::utils::source_access::open(format!("/proc/{pid}/stat"))
        .ok()?
        .take(8193)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    let stat = std::str::from_utf8(&bytes).ok()?;
    // Keep both quantities in the same /proc view. Container providers may
    // virtualize start ticks and uptime while CLOCK_BOOTTIME remains host-wide.
    let mut uptime_bytes = Vec::new();
    crate::utils::source_access::open("/proc/uptime")
        .ok()?
        .take(129)
        .read_to_end(&mut uptime_bytes)
        .ok()?;
    if uptime_bytes.len() > 128 {
        return None;
    }
    let uptime = std::str::from_utf8(&uptime_bytes)
        .ok()?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()?
        * 1000.0;
    // SAFETY: sysconf accepts the constant and has no pointer arguments.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let current = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.0;
    linux_birth_ms(stat, current, uptime, ticks as f64)
}
#[cfg(any(target_os = "linux", test))]
fn linux_birth_ms(stat: &str, current: f64, uptime: f64, hz: f64) -> Option<f64> {
    if !current.is_finite() || !uptime.is_finite() || !hz.is_finite() || hz <= 0.0 || uptime < 0.0 {
        return None;
    }
    let end = stat.rfind(')')?;
    let started = stat[end + 1..]
        .split_whitespace()
        .nth(19)?
        .parse::<u64>()
        .ok()? as f64
        / hz
        * 1000.0;
    if started > uptime + 1000.0 {
        return None;
    }
    Some(current - uptime + started)
}
#[cfg(windows)]
pub(super) fn birth_ms(pid: u32) -> Option<f64> {
    let token = crate::utils::pid_utils::read_process_start_token(pid);
    let ticks = token
        .strip_prefix("win32-filetime-v1:")?
        .parse::<u64>()
        .ok()?;
    Some(ticks.checked_sub(116_444_736_000_000_000)? as f64 / 10000.0)
}
#[cfg(target_os = "macos")]
pub(super) fn birth_ms(pid: u32) -> Option<f64> {
    let pid = i32::try_from(pid).ok()?;
    if pid <= 0 {
        return None;
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: bounded single-PID metadata API, exact output buffer layout/size.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if read != size as i32 {
        return None;
    }
    // SAFETY: a complete successful proc_pidinfo call initialized the structure.
    let info = unsafe { info.assume_init() };
    Some(info.pbi_start_tvsec as f64 * 1000.0 + info.pbi_start_tvusec as f64 / 1000.0)
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(super) fn birth_ms(_: u32) -> Option<f64> {
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_single_pid_metadata_returns_current_process_birth_and_missing_pid_is_unknown() {
        let now = chrono::Utc::now().timestamp_millis() as f64;
        let born = birth_ms(std::process::id()).expect("current process has native birth metadata");
        assert!(born <= now + 1000.0);
        assert!(now - born < 24.0 * 60.0 * 60.0 * 1000.0);
        assert!(birth_ms(0).is_none());
        assert!(birth_ms(u32::MAX).is_none());
    }
    #[test]
    fn linux_stat_parser_uses_start_ticks_after_parenthesized_names_and_rejects_bad_clock_values() {
        let mut fields = vec!["S".to_owned(); 20];
        fields[19] = "500".into();
        let stat = format!("42 (synthetic ) name) {}", fields.join(" "));
        assert_eq!(
            linux_birth_ms(&stat, 1000000.0, 10000.0, 100.0),
            Some(995000.0)
        );
        assert!(linux_birth_ms("bad", 0.0, 0.0, 100.0).is_none());
        assert!(linux_birth_ms(&stat, 0.0, 0.0, 0.0).is_none());
        assert!(linux_birth_ms(&stat, 0.0, 0.0, 100.0).is_none());
    }
}
