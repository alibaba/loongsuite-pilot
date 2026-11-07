//! Versioned, C-compatible ABI shared by the library and the small native host.
use std::ffi::{c_char, c_void};

pub const ABI_VERSION: u32 = 2;
pub const OK: i32 = 0;
pub const BAD_ARGUMENT: i32 = 1;
pub const BUSY: i32 = 2;
pub const FAILURE: i32 = 3;
pub const ACK: i32 = 0;
pub const RETRY: i32 = 1;
pub const CAP_ACTIVITY_V2: u64 = 1;
pub const CAP_HOOK_UDP: u64 = 2;
pub const CAP_MONITORING: u64 = 4;

#[repr(C)]
pub struct PilotHandle {
    _opaque: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PilotJsonView {
    pub data: *const u8,
    pub len: usize,
}

impl PilotJsonView {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            data: bytes.as_ptr(),
            len: bytes.len(),
        }
    }
}

pub type OnBatch = unsafe extern "C" fn(*mut c_void, *const PilotJsonView, usize) -> i32;
pub type OnLifecycle = unsafe extern "C" fn(*mut c_void, *mut PilotHandle, i32, PilotJsonView);
pub type OnHook =
    unsafe extern "C" fn(*mut c_void, PilotJsonView, u32, *mut u8, usize, *mut usize) -> i32;
pub type Start = unsafe extern "C" fn(
    PilotJsonView,
    PilotJsonView,
    Option<OnBatch>,
    Option<OnBatch>,
    Option<OnHook>,
    Option<OnLifecycle>,
    Option<OnLifecycle>,
    *mut c_void,
    *mut *mut PilotHandle,
) -> i32;
pub type Report = unsafe extern "C" fn(*mut PilotHandle, *mut *mut c_char, *mut usize) -> i32;
pub type Apply =
    unsafe extern "C" fn(*mut PilotHandle, PilotJsonView, *mut *mut c_char, *mut usize) -> i32;

#[repr(C)]
pub struct PilotApiV2 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub capabilities: u64,
    pub start: Start,
    pub apply_policy: Apply,
    pub snapshot: Report,
    pub stop: unsafe extern "C" fn(*mut PilotHandle, u32) -> i32,
    pub destroy: unsafe extern "C" fn(*mut PilotHandle) -> i32,
    pub string_free: unsafe extern "C" fn(*mut c_char),
    /// Dispatch lifecycle notifications on the host control thread, after the
    /// corresponding accepting start/stop call returned. Never invoke concurrently.
    pub dispatch: unsafe extern "C" fn(*mut PilotHandle, u32) -> i32,
    /// Complete Pilot command host. The embedded collector never calls this.
    pub host_main: unsafe extern "C" fn() -> i32,
    /// Full Pilot Hook evaluation with captured Agent output. Called only by
    /// the deadline worker; the native main thread alone writes stdout.
    pub host_hook:
        unsafe extern "C" fn(PilotJsonView, PilotJsonView, *mut *mut c_char, *mut usize) -> i32,
}
