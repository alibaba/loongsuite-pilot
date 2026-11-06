//! Scoped equivalents of the original per-test fs mocks. No release hook.
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) enum Action {
    Error(&'static str),
    Appear { at: usize, contents: &'static str },
}
pub(super) struct Rule {
    operation: &'static str,
    path: PathBuf,
    action: Action,
}
impl Rule {
    pub(super) fn read_error(path: PathBuf) -> Self {
        Self {
            operation: "read",
            path,
            action: Action::Error("EACCES"),
        }
    }
    pub(super) fn stat_error(path: PathBuf, code: &'static str) -> Self {
        Self {
            operation: "stat",
            path,
            action: Action::Error(code),
        }
    }
    pub(super) fn appear_on_second_stat(path: PathBuf) -> Self {
        Self {
            operation: "stat",
            path,
            action: Action::Appear {
                at: 2,
                contents: "/* appeared during discovery */",
            },
        }
    }
}
struct Plan {
    rules: Vec<Rule>,
    counts: HashMap<(&'static str, PathBuf), usize>,
}
tokio::task_local! {static PLAN:RefCell<Plan>;}
pub(super) async fn scope<T>(rules: Vec<Rule>, future: impl Future<Output = T>) -> T {
    PLAN.scope(
        RefCell::new(Plan {
            rules,
            counts: HashMap::new(),
        }),
        future,
    )
    .await
}
pub(super) fn count(operation: &'static str, path: &Path) -> usize {
    PLAN.with(|plan| {
        *plan
            .borrow()
            .counts
            .get(&(operation, path.to_path_buf()))
            .unwrap_or(&0)
    })
}
fn error_number(code: &str) -> i32 {
    match code {
        "EACCES" => {
            if cfg!(windows) {
                5
            } else {
                13
            }
        }
        "EPERM" => {
            if cfg!(windows) {
                1314
            } else {
                1
            }
        }
        "ELOOP" => {
            if cfg!(windows) {
                1921
            } else if cfg!(target_os = "macos") {
                62
            } else {
                40
            }
        }
        _ => panic!("unknown fixture error code"),
    }
}
pub(super) fn before(operation: &'static str, path: &Path) -> std::io::Result<()> {
    let action = PLAN
        .try_with(|plan| {
            let mut plan = plan.borrow_mut();
            let count = plan
                .counts
                .entry((operation, path.to_path_buf()))
                .or_default();
            *count += 1;
            let count = *count;
            plan.rules
                .iter()
                .find(|rule| rule.operation == operation && rule.path == path)
                .map(|rule| (count, rule.action.clone()))
        })
        .ok()
        .flatten();
    match action {
        Some((_, Action::Error(code))) => {
            Err(std::io::Error::from_raw_os_error(error_number(code)))
        }
        Some((count, Action::Appear { at, contents })) if count == at => {
            std::fs::write(path, contents)
        }
        _ => Ok(()),
    }
}
