//! Connect installed Hook invocations to the shared runtime ABI.

pub fn run(args: &[String]) -> Option<String> {
    use crate::host_loader::{self, abi::PilotJsonView, Library};
    use std::io::Read;
    let max_input = if args.first().is_some_and(|arg| arg == "hook-process") {
        1024 * 1024
    } else {
        5 * 1024 * 1024
    };
    let mut body = Vec::new();
    std::io::stdin()
        .take((max_input + 1) as u64)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() > max_input {
        return None;
    }
    let library = Library::open(&host_loader::library_path().ok()?).ok()?;
    let argv = serde_json::to_vec(args).ok()?;
    let mut report = std::ptr::null_mut();
    let mut length = 0;
    // SAFETY: buffers and library remain owned through the synchronous call.
    let code = unsafe {
        (library.api().host_hook)(
            PilotJsonView::from_bytes(&argv),
            PilotJsonView::from_bytes(&body),
            &mut report,
            &mut length,
        )
    };
    if report.is_null() {
        return None;
    }
    // SAFETY: SDK-owned output with explicit length, freed by the same library.
    let result = serde_json::from_slice::<serde_json::Value>(unsafe {
        std::slice::from_raw_parts(report.cast::<u8>(), length)
    });
    unsafe {
        (library.api().string_free)(report);
    }
    // The hook process exits immediately; retain any process-global logger.
    std::mem::forget(library);
    if code != 0 {
        return None;
    }
    result.ok()?.get("stdout")?.as_str().map(str::to_owned)
}
