#[path = "../sdk/hook_bin.rs"]
mod hook_bin;

fn main() {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("sdk-hook") {
        hook_bin::run(args, started, None);
    }
}
