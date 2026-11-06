//! Port of `src/utils/process-discovery.ts`.

use super::pid_utils::{
    match_windows_process_scan, UPDATER_PROCESS_PATTERNS, WINDOWS_PROCESS_SCAN_ARGS,
    WINDOWS_PROCESS_SCAN_ENCODING, WINDOWS_PROCESS_SCAN_PROGRAM, WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
    WINDOWS_PROCESS_SCAN_WINDOWS_HIDE,
};

pub fn is_updater_running_on_windows_sync() -> bool {
    if !cfg!(windows) {
        return false;
    }
    super::pid_utils::find_process_by_command(UPDATER_PROCESS_PATTERNS).running
}

/// Windows updater scan without spawning PowerShell.
///
/// `Err(())` is the powershell-threw case. On a non-Windows platform the real
/// function returns before any scan, which [`is_updater_running_on_windows_sync`]
/// covers on this host.
pub fn updater_running_from_scan(win32: bool, output: Result<&str, ()>) -> bool {
    if !win32 {
        return false;
    }
    match output {
        Ok(text) => {
            match_windows_process_scan(text, UPDATER_PROCESS_PATTERNS, std::process::id()).running
        }
        Err(()) => false,
    }
}

pub fn windows_updater_scan_spec() -> (
    &'static str,
    &'static [&'static str],
    u64,
    &'static str,
    bool,
) {
    (
        WINDOWS_PROCESS_SCAN_PROGRAM,
        WINDOWS_PROCESS_SCAN_ARGS,
        WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
        WINDOWS_PROCESS_SCAN_ENCODING,
        WINDOWS_PROCESS_SCAN_WINDOWS_HIDE,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        is_updater_running_on_windows_sync, updater_running_from_scan, windows_updater_scan_spec,
    };

    #[test]
    fn returns_false_and_does_not_scan_on_non_windows() {
        if !cfg!(windows) {
            assert!(!is_updater_running_on_windows_sync());
        }
        assert!(!updater_running_from_scan(
            false,
            Ok("12345\tupdater-daemon.js\n")
        ));
    }

    #[test]
    fn returns_true_when_powershell_output_contains_a_matching_updater_command() {
        let output = "12345\tnode C:\\Users\\test\\.loongsuite-pilot\\bin\\updater-daemon.js\r\n";
        assert!(updater_running_from_scan(true, Ok(output)));
        let (program, args, timeout, encoding, windows_hide) = windows_updater_scan_spec();
        assert_eq!(program, "powershell.exe");
        assert!(args.contains(&"-NoProfile"));
        assert!(args.contains(&"-WindowStyle"));
        assert!(args.contains(&"Hidden"));
        assert!(args.contains(&"-Command"));
        assert_eq!(timeout, 8000);
        assert_eq!(encoding, "utf-8");
        assert!(windows_hide);
    }

    #[test]
    fn returns_false_when_output_has_no_matching_updater_command() {
        assert!(!updater_running_from_scan(
            true,
            Ok("12345\tnode unrelated.js\r\n")
        ));
    }

    #[test]
    fn returns_false_when_powershell_output_is_empty() {
        assert!(!updater_running_from_scan(true, Ok("")));
    }

    #[test]
    fn returns_false_when_powershell_throws() {
        assert!(!updater_running_from_scan(true, Err(())));
    }
}
