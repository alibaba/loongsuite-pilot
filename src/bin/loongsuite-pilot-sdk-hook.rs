#[path = "../sdk/hook_bin.rs"]
mod hook_bin;

fn main() {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|command| command == "sdk-hook") {
        hook_bin::run(args, started, None);
    }
    if hook_bin::is_hook(&args) {
        forward_legacy(&args);
    }
}

// Installed settings from before this migration can still name this binary.
// A CloudShell package ships no full Pilot executable, so such commands fail open.
fn forward_legacy(args: &[String]) {
    let Ok(path) = std::env::current_exe() else {
        return;
    };
    let host = path.with_file_name(format!("loongsuite-pilot{}", std::env::consts::EXE_SUFFIX));
    if !std::fs::symlink_metadata(&host).is_ok_and(|metadata| metadata.is_file()) {
        return;
    }
    let mut command = std::process::Command::new(host);
    command.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = command.exec();
    }
    #[cfg(not(unix))]
    if let Ok(status) = command.status() {
        std::process::exit(status.code().unwrap_or(0));
    }
}
