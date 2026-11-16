#[path = "../sdk/abi.rs"]
pub mod abi;
#[path = "../sdk/hook_bin.rs"]
mod hook_bin;
#[path = "../sdk/host_hook_client.rs"]
mod host_hook_client;
#[allow(dead_code)]
#[path = "../sdk/host_loader.rs"]
mod host_loader;

fn main() {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if hook_bin::is_hook(&args) {
        hook_bin::run(args, started, Some(host_hook_client::run));
    }
}
