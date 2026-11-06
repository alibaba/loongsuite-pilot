//! Numeric PPID and second-resolution start time cannot authorize an old child.
use super::*;

fn identity(pid: u32, created: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        creation_time: created.into(),
        executable_path: format!("fixture-{pid}"),
    }
}

#[test]
fn child_from_previous_pid_generation_is_rejected_even_in_the_same_sysinfo_second() {
    let parent = identity(40001, "2026-11-04T04:00:00.700000000Z");
    let foreign_child = identity(40002, "2026-11-04T04:00:00.200000000Z");
    let parent_time = chrono::DateTime::parse_from_rfc3339(&parent.creation_time).unwrap();
    let child_time = chrono::DateTime::parse_from_rfc3339(&foreign_child.creation_time).unwrap();
    assert_eq!(child_time.timestamp(), parent_time.timestamp());
    // The old whole-second predicate admitted this PPID candidate.
    assert!(child_time.timestamp() >= parent_time.timestamp());
    assert!(!windows_child_not_older_than_parent(&foreign_child, &parent).unwrap());
    // Preserve FILETIME's 100ns distinction instead of truncating milliseconds.
    let older_by_tick = identity(40003, "2026-11-04T04:00:00.699999900Z");
    assert!(!windows_child_not_older_than_parent(&older_by_tick, &parent).unwrap());
}

#[test]
fn equal_later_and_offset_times_pass_while_unknown_creation_times_fail_closed() {
    let parent = identity(40001, "2026-11-04T04:00:00.700000000Z");
    for created in [
        "2026-11-04T04:00:00.700000000Z",
        "2026-11-04T04:00:00.700000100Z",
        "2026-11-04T04:00:01.000000000Z",
        "2026-11-04T12:00:00.700000000+08:00",
    ] {
        assert!(windows_child_not_older_than_parent(&identity(40002, created), &parent).unwrap());
    }
    for invalid in ["", "unparseable", "2026-11-04", "nan"] {
        let unknown = identity(40002, invalid);
        assert!(windows_child_not_older_than_parent(&unknown, &parent).is_err());
        assert!(windows_child_not_older_than_parent(&parent, &unknown).is_err());
    }
}
