//! Recursive directory watch. A failure leaves polling in place, matching
//! `fs.watch` being swallowed in `WorkBuddyInput.watchDirectory`.

use std::collections::HashMap;
use std::ffi::{c_char, c_int as RawFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use super::CollectorWake;

const IN_MODIFY: u32 = 0x0000_0002;
const IN_ATTRIB: u32 = 0x0000_0004;
const IN_CLOSE_WRITE: u32 = 0x0000_0008;
const IN_MOVED_FROM: u32 = 0x0000_0040;
const IN_MOVED_TO: u32 = 0x0000_0080;
const IN_CREATE: u32 = 0x0000_0100;
const IN_DELETE: u32 = 0x0000_0200;
const IN_DELETE_SELF: u32 = 0x0000_0400;
const IN_MOVE_SELF: u32 = 0x0000_0800;
const IN_ISDIR: u32 = 0x4000_0000;
const WATCH_MASK: u32 = IN_MODIFY
    | IN_ATTRIB
    | IN_CLOSE_WRITE
    | IN_MOVED_FROM
    | IN_MOVED_TO
    | IN_CREATE
    | IN_DELETE
    | IN_DELETE_SELF
    | IN_MOVE_SELF;
/// `IN_CLOEXEC | IN_NONBLOCK`.
const INIT_FLAGS: i32 = 0x80000 | 0x800;

pub struct DirWatch {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl DirWatch {
    pub fn start(dir: &str, wake: Arc<CollectorWake>) -> Option<Self> {
        if !cfg!(target_os = "linux") || !Path::new(dir).is_dir() {
            return None;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);
        let root = dir.to_string();
        let thread = std::thread::Builder::new()
            .name("workbuddy-watch".into())
            .spawn(move || watch_loop(&root, wake, stop_flag))
            .ok()?;
        Some(Self {
            stop,
            thread: Some(thread),
        })
    }

    pub fn close(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for DirWatch {
    fn drop(&mut self) {
        self.close();
    }
}

fn watch_loop(root: &str, wake: Arc<CollectorWake>, stop: Arc<AtomicBool>) {
    let fd = unsafe { sys_inotify_init1(INIT_FLAGS) };
    if fd < 0 {
        return;
    }
    let mut watches = HashMap::new();
    add_tree(fd, Path::new(root), &mut watches);
    if watches.is_empty() {
        unsafe { sys_close(fd) };
        return;
    }
    let mut buf = [0u8; 4096];
    while !stop.load(Ordering::SeqCst) {
        let mut poll_fd = PollFd {
            fd,
            events: 1,
            revents: 0,
        };
        let ready = unsafe { sys_poll(&mut poll_fd, 1, 50) };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if ready < 0 {
            let err = errno();
            if err == 4 {
                continue;
            }
            break;
        }
        if ready == 0 {
            continue;
        }
        let read = unsafe { sys_read(fd, buf.as_mut_ptr(), buf.len()) };
        if read < 0 {
            let err = errno();
            if err == 11 || err == 4 {
                continue;
            }
            break;
        }
        if read == 0 {
            break;
        }
        let mut saw_event = false;
        let mut offset = 0usize;
        let read = read as usize;
        while offset + 16 <= read {
            let wd = i32::from_ne_bytes(buf[offset..offset + 4].try_into().unwrap_or([0; 4]));
            let mask = u32::from_ne_bytes(buf[offset + 4..offset + 8].try_into().unwrap_or([0; 4]));
            let len = u32::from_ne_bytes(buf[offset + 12..offset + 16].try_into().unwrap_or([0; 4]))
                as usize;
            let name_start = offset + 16;
            let name_end = (name_start + len).min(read);
            saw_event = true;
            if name_end > name_start {
                let raw = &buf[name_start..name_end];
                let raw = raw.split(|byte| *byte == 0).next().unwrap_or(raw);
                if let Ok(name) = std::str::from_utf8(raw) {
                    if !name.is_empty() {
                        let parent = watches.get(&wd).cloned();
                        if let Some(dir) = parent {
                            let child = dir.join(name);
                            if mask & IN_CREATE != 0 && mask & IN_ISDIR != 0 {
                                add_tree(fd, &child, &mut watches);
                            }
                        }
                    }
                }
            }
            let next = if len == 0 {
                name_start
            } else {
                name_end.max(name_start)
            };
            if next <= offset {
                break;
            }
            offset = next;
        }
        if saw_event {
            wake.request();
        }
    }
    unsafe { sys_close(fd) };
}

fn add_tree(fd: RawFd, root: &Path, watches: &mut HashMap<i32, PathBuf>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Some(wd) = add_watch(fd, &dir) {
            watches.insert(wd, dir.clone());
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push(entry.path());
            }
        }
    }
}

fn add_watch(fd: RawFd, dir: &Path) -> Option<i32> {
    let text = dir.to_string_lossy();
    let c_dir = std::ffi::CString::new(text.as_ref()).ok()?;
    let wd = unsafe { sys_inotify_add_watch(fd, c_dir.as_ptr(), WATCH_MASK) };
    if wd >= 0 {
        Some(wd)
    } else {
        None
    }
}

#[repr(C)]
struct PollFd {
    fd: i32,
    events: i16,
    revents: i16,
}

#[cfg(target_os = "linux")]
unsafe fn sys_inotify_init1(flags: i32) -> i32 {
    unsafe extern "C" {
        fn inotify_init1(flags: i32) -> i32;
    }
    unsafe { inotify_init1(flags) }
}

#[cfg(target_os = "linux")]
unsafe fn sys_inotify_add_watch(fd: i32, path: *const c_char, mask: u32) -> i32 {
    unsafe extern "C" {
        fn inotify_add_watch(fd: i32, pathname: *const c_char, mask: u32) -> i32;
    }
    unsafe { inotify_add_watch(fd, path, mask) }
}

#[cfg(target_os = "linux")]
unsafe fn sys_poll(fds: *mut PollFd, nfds: u64, timeout_ms: i32) -> i32 {
    unsafe extern "C" {
        fn poll(fds: *mut PollFd, nfds: u64, timeout: i32) -> i32;
    }
    unsafe { poll(fds, nfds, timeout_ms) }
}

#[cfg(target_os = "linux")]
fn errno() -> i32 {
    unsafe extern "C" {
        fn __errno_location() -> *mut i32;
    }
    unsafe { *__errno_location() }
}

#[cfg(target_os = "linux")]
unsafe fn sys_read(fd: i32, buf: *mut u8, len: usize) -> isize {
    unsafe extern "C" {
        fn read(fd: i32, buf: *mut std::ffi::c_void, count: usize) -> isize;
    }
    unsafe { read(fd, buf.cast(), len) }
}

#[cfg(target_os = "linux")]
unsafe fn sys_close(fd: i32) -> i32 {
    unsafe extern "C" {
        fn close(fd: i32) -> i32;
    }
    unsafe { close(fd) }
}

#[cfg(not(target_os = "linux"))]
unsafe fn sys_inotify_init1(_flags: i32) -> i32 {
    -1
}
#[cfg(not(target_os = "linux"))]
unsafe fn sys_inotify_add_watch(_fd: i32, _path: *const c_char, _mask: u32) -> i32 {
    -1
}
#[cfg(not(target_os = "linux"))]
unsafe fn sys_poll(_fds: *mut PollFd, _nfds: u64, _timeout_ms: i32) -> i32 {
    -1
}
#[cfg(not(target_os = "linux"))]
fn errno() -> i32 {
    0
}
#[cfg(not(target_os = "linux"))]
unsafe fn sys_read(_fd: i32, _buf: *mut u8, _len: usize) -> isize {
    -1
}
#[cfg(not(target_os = "linux"))]
unsafe fn sys_close(_fd: i32) -> i32 {
    0
}
