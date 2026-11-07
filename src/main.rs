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
        hook_bin::run(args, started);
    }
    match host_loader::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("loongsuite-pilot: cannot load Pilot SDK: {error}");
            std::process::exit(1);
        }
    }
}
