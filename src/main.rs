#[path = "sdk/abi.rs"]
pub mod abi;
#[path = "sdk/hook_bin.rs"]
mod hook_bin;
#[path = "sdk/host_loader.rs"]
pub mod host_loader;
mod legacy_hook;

fn main() {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "internal-qoder-token-usage")
    {
        std::process::exit(
            loongsuite_pilot::deployment::qoder_token_usage::profile_helper(&args[1..]),
        );
    }
    if args
        .first()
        .is_some_and(|arg| arg == "internal-agent-config-directory")
    {
        std::process::exit(loongsuite_pilot::cli_main::create_agent_config_directory(
            &args[1..],
        ));
    }
    if args.first().is_some_and(|arg| arg == "hook-process")
        && args.get(1).is_some_and(|arg| arg == "qoder")
        && args.iter().any(|arg| arg == "--wakeup-only")
    {
        std::process::exit(loongsuite_pilot::hook_process::run_hook_process("qoder"));
    }
    if args.first().is_some_and(|arg| arg == "hook-process")
        && args.get(1).is_some_and(|arg| arg == "cursor")
        && args.iter().any(|arg| arg == "--defer-assembly")
    {
        std::process::exit(loongsuite_pilot::hook_process::run_hook_process("cursor"));
    }
    if hook_bin::is_hook(&args) {
        hook_bin::run(legacy_hook::sdk_args(args), started, Some(legacy_hook::run));
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
