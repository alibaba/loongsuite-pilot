//! Compatibility commands owned by the full Pilot executable.

pub fn run(args: &[String]) -> Option<String> {
    use std::io::Read;
    let max_input = if args.first().is_some_and(|arg| arg == "hook-process")
        && args.get(1).is_some_and(|arg| arg == "qoder")
    {
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
    loongsuite_pilot::hook_process::run_legacy_host_hook(args, &body)
}

/// Existing installed Qoder command hooks still work while the shell
/// transactionally reconciles their configuration to the native SDK command.
pub fn sdk_args(args: Vec<String>) -> Vec<String> {
    if args.first().map(String::as_str) != Some("interceptor")
        || args.get(1).map(String::as_str) != Some("hook")
    {
        return args;
    }
    let option = |name: &str| {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].as_str())
    };
    let Some(agent @ ("qoder-auto" | "qoder" | "qodercli")) = option("--agent") else {
        return args;
    };
    let data = option("--data-dir")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOONGSUITE_PILOT_DATA_DIR")
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
        });
    let Some(data) = data.filter(|data| data.is_absolute()) else {
        return args;
    };
    let mut native = [
        "sdk-hook",
        "--channel",
        "local",
        "--agent",
        agent,
        "--data-dir",
    ]
    .map(str::to_owned)
    .to_vec();
    native.push(
        data.join("state")
            .join("standalone-qoder-sdk")
            .to_string_lossy()
            .into_owned(),
    );
    if let Some(event) = option("--event") {
        native.extend(["--event".into(), event.into()]);
    }
    native
}
