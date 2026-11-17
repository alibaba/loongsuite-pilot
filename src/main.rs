#[path = "sdk/abi.rs"]
pub mod abi;
#[path = "sdk/hook_bin.rs"]
mod hook_bin;
#[path = "sdk/host_hook_client.rs"]
mod host_hook_client;
#[path = "sdk/host_loader.rs"]
pub mod host_loader;

fn main() {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if hook_bin::is_hook(&args) && args.first().is_some_and(|arg| arg != "hook-process") {
        hook_bin::run(
            host_hook_client::sdk_args(args),
            started,
            Some(host_hook_client::run),
        );
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
