#[path = "sdk/hook_bin.rs"]
mod hook_bin;
#[path = "sdk/host_loader.rs"]
pub mod host_loader;

fn main() {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("sdk-hook")
        || (args.first().map(String::as_str) == Some("interceptor")
            && args.get(1).map(String::as_str) == Some("hook"))
    {
        hook_bin::run(args, started, Some(legacy_worker));
    }
    let _sdk = match host_loader::library_path().and_then(|path| host_loader::Library::open(&path))
    {
        Ok(library) => library,
        Err(error) => {
            eprintln!("loongsuite-pilot: cannot load Pilot SDK: {error}");
            std::process::exit(1);
        }
    };
    let result = (|| -> anyhow::Result<i32> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(loongsuite_pilot::cli_main::run());
        runtime.shutdown_background();
        result
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("loongsuite-pilot: {error}");
            std::process::exit(1);
        }
    }
}

// Keep full Pilot's existing HTTP/Agent protocol, while covering cold library
// loading and stdin with the same process-wide native deadline.
fn legacy_worker(args: &[String]) -> Option<String> {
    use crate::host_loader::{self, abi::PilotJsonView, Library};
    use std::io::Read;
    let mut body = Vec::new();
    std::io::stdin()
        .take(5 * 1024 * 1024 + 1)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() > 5 * 1024 * 1024 {
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
