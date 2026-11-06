#[tokio::main]
async fn main() {
    match loongsuite_pilot::cli_main::run().await {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("loongsuite-pilot: {err}");
            std::process::exit(1);
        }
    }
}
