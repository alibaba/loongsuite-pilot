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
