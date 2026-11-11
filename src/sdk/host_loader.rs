//! Native loader only: no statically linked collector fallback.
#[path = "abi.rs"]
pub mod abi;

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod platform {
    use super::*;
    #[cfg_attr(target_os = "linux", link(name = "dl"))]
    unsafe extern "C" {
        fn dlopen(path: *const c_char, flags: i32) -> *mut c_void;
        fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
        fn dlerror() -> *const c_char;
        fn dlclose(handle: *mut c_void) -> i32;
    }
    pub unsafe fn open(path: &Path) -> Result<*mut c_void, String> {
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        // SAFETY: owned, NUL-terminated path; RTLD_NOW | RTLD_LOCAL.
        let handle = unsafe { dlopen(path.as_ptr(), 2) };
        if handle.is_null() {
            // SAFETY: dlerror returns either NULL or a NUL-terminated thread-local string.
            let error = unsafe { dlerror() };
            return Err(if error.is_null() {
                "dynamic loader failed".into()
            } else {
                unsafe { std::ffi::CStr::from_ptr(error) }
                    .to_string_lossy()
                    .into_owned()
            });
        }
        Ok(handle)
    }
    pub unsafe fn symbol(handle: *mut c_void) -> *mut c_void {
        // SAFETY: live library and static NUL-terminated symbol name.
        unsafe { dlsym(handle, c"aah_collector_get_api_v2".as_ptr()) }
    }
    pub unsafe fn close(handle: *mut c_void) {
        // SAFETY: no SDK instances/calls remain when the owner drops the library.
        unsafe {
            dlclose(handle);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
    }
    pub unsafe fn open(path: &Path) -> Result<*mut c_void, String> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: absolute, terminated path. Restrict dependency loading to the
        // DLL directory and System32 instead of the current working directory.
        let handle = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800) };
        if handle.is_null() {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(handle)
        }
    }
    pub unsafe fn symbol(handle: *mut c_void) -> *mut c_void {
        // SAFETY: live module and static NUL-terminated symbol name.
        unsafe { GetProcAddress(handle, c"aah_collector_get_api_v2".as_ptr()) }
    }
    pub unsafe fn close(handle: *mut c_void) {
        // SAFETY: all calls/instances are complete before unload.
        unsafe {
            FreeLibrary(handle);
        }
    }
}

pub struct Library {
    handle: *mut c_void,
    api: *const abi::PilotApiV2,
}

impl Library {
    pub fn open(path: &Path) -> Result<Self, String> {
        // SAFETY: path and library ownership are retained by this object.
        let handle = unsafe { platform::open(path)? };
        // SAFETY: handle is live.
        let symbol = unsafe { platform::symbol(handle) };
        if symbol.is_null() {
            unsafe {
                platform::close(handle);
            }
            return Err("SDK is missing aah_collector_get_api_v2".into());
        }
        // SAFETY: the named export is defined by the versioned SDK C contract.
        let get_api: unsafe extern "C" fn() -> *const abi::PilotApiV2 =
            unsafe { std::mem::transmute(symbol) };
        let api = unsafe { get_api() };
        // Read only the fixed prefix before verifying the whole table length.
        if api.is_null()
            || unsafe {
                (*api).abi_version != abi::ABI_VERSION
                    || (*api).struct_size < std::mem::size_of::<abi::PilotApiV2>() as u32
            }
        {
            unsafe {
                platform::close(handle);
            }
            return Err("SDK ABI version or function table size mismatch".into());
        }
        Ok(Self { handle, api })
    }

    pub fn api(&self) -> &abi::PilotApiV2 {
        // SAFETY: validated immutable API remains live for this library borrow.
        unsafe { &*self.api }
    }

    pub fn run(&self) -> i32 {
        // SAFETY: immutable validated API table and live library; this command
        // owns its runtime until host_main returns.
        unsafe { ((*self.api).host_main)() }
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        // SAFETY: run is synchronous and cannot outlive its library borrow.
        unsafe {
            platform::close(self.handle);
        }
    }
}

pub fn library_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("LOONGSUITE_PILOT_SDK_LIBRARY") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("SDK override must be an absolute path".into());
        }
        return Ok(path);
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("executable has no parent")?;
    let name = if cfg!(windows) {
        "loongsuite_pilot.dll"
    } else if cfg!(target_os = "macos") {
        "libloongsuite_pilot.dylib"
    } else {
        "libloongsuite_pilot.so"
    };
    // The full runtime keeps schema-1 compatibility with old updaters by
    // placing its SDK beside the executable in the already allowed bin directory.
    let development = directory.join(name);
    if development.is_file() {
        return Ok(development);
    }
    let packaged = directory.join("../lib").join(name);
    if packaged.is_file() {
        return Ok(packaged);
    }
    if directory.join(".cargo-lock").is_file() {
        return Ok(directory.join("deps").join(name));
    }
    Ok(development)
}

pub fn run() -> Result<i32, String> {
    let library = Library::open(&library_path()?)?;
    let code = library.run();
    // The complete command owns the process. Keep process-global logging and
    // host-plugin callbacks resident until OS exit; embedded handles instead
    // use destroy and explicit unload through Library's normal Drop.
    std::mem::forget(library);
    Ok(code)
}
