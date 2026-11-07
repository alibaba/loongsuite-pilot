//! Package fixtures execute the same host + library pair as shipped runtimes.
use std::path::{Path, PathBuf};

pub fn copy_sdk(directory: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "loongsuite_pilot.dll"
    } else if cfg!(target_os = "macos") {
        "libloongsuite_pilot.dylib"
    } else {
        "libloongsuite_pilot.so"
    };
    let binary = Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    let profile = binary.parent().unwrap();
    let source = [profile.join(name), profile.join("deps").join(name)]
        .into_iter()
        .find(|p| p.is_file())
        .expect("build the SDK companion before native fixture tests");
    std::fs::create_dir_all(directory).unwrap();
    let destination = directory.join(name);
    std::fs::copy(source, &destination).unwrap();
    destination
}
