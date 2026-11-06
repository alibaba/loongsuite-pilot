//! Shared bounded empty-file lock; interoperable with existing Agent host scripts.
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

pub fn with_file_lock<T>(
    lock_file: &Path,
    wait_ms: u64,
    stale_ms: u64,
    action: impl FnOnce() -> T,
) -> Option<T> {
    let deadline = lock_now() + std::time::Duration::from_millis(wait_ms);
    if let Some(parent) = lock_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut acquired = false;
    let result = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_file)
        {
            Ok(file) => {
                drop(file);
                acquired = true;
                break Some(action());
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                if let Ok(meta) = fs::metadata(lock_file) {
                    if let Ok(modified) = meta.modified() {
                        if modified
                            .elapsed()
                            .map(|age| age.as_millis() as u64 > stale_ms)
                            .unwrap_or(false)
                        {
                            let _ = fs::remove_file(lock_file);
                            continue;
                        }
                    }
                }
                if lock_now() >= deadline {
                    break None;
                }
                lock_sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => break None,
        }
    };
    if acquired {
        let _ = fs::remove_file(lock_file);
    }
    result
}

fn lock_now() -> std::time::Instant {
    #[cfg(test)]
    if let Some(clock) = TEST_CLOCK.with_borrow(Clone::clone) {
        return (clock.now)();
    }
    std::time::Instant::now()
}
fn lock_sleep(duration: std::time::Duration) {
    #[cfg(test)]
    if let Some(clock) = TEST_CLOCK.with_borrow(Clone::clone) {
        (clock.sleep)(duration);
        return;
    }
    std::thread::sleep(duration);
}
#[cfg(test)]
#[derive(Clone)]
struct TestClock {
    now: std::sync::Arc<dyn Fn() -> std::time::Instant + Send + Sync>,
    sleep: std::sync::Arc<dyn Fn(std::time::Duration) + Send + Sync>,
}
#[cfg(test)]
thread_local! {static TEST_CLOCK:std::cell::RefCell<Option<TestClock>>=const{std::cell::RefCell::new(None)};}
#[cfg(test)]
pub(crate) fn with_test_clock<T>(
    now: std::sync::Arc<dyn Fn() -> std::time::Instant + Send + Sync>,
    sleep: std::sync::Arc<dyn Fn(std::time::Duration) + Send + Sync>,
    action: impl FnOnce() -> T,
) -> T {
    struct Restore(Option<TestClock>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_CLOCK.with_borrow_mut(|clock| *clock = self.0.take());
        }
    }
    let prior = TEST_CLOCK.with_borrow_mut(|clock| clock.replace(TestClock { now, sleep }));
    let _restore = Restore(prior);
    action()
}
