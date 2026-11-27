//! Stages the original resource layout for tests that deliberately deploy
//! the historical Cursor definition. No legacy wrapper is shipped.
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn stage(parent: &Path) -> PathBuf {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = parent.join("legacy-cursor-runtime");
    for dir in ["src", "agents.d", "assets/hooks/shared"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    // Runtime root resolution checks these markers for a development tree.
    fs::write(root.join("Cargo.toml"), b"").unwrap();
    fs::write(root.join("src/main.rs"), b"").unwrap();
    for entry in fs::read_dir(checkout.join("agents.d")).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file()
            && entry.path().extension().is_some_and(|ext| ext == "json")
        {
            fs::copy(entry.path(), root.join("agents.d").join(entry.file_name())).unwrap();
        }
    }
    for filename in [
        "cursor-loongsuite-pilot-hook.sh",
        "cursor-loongsuite-pilot-hook.ps1",
    ] {
        fs::copy(
            checkout
                .join("tests/fixtures/legacy-migrated-hooks")
                .join(filename),
            root.join("assets/hooks").join(filename),
        )
        .unwrap();
    }
    for filename in ["native.sh", "native.ps1"] {
        fs::copy(
            checkout.join("assets/hooks/shared").join(filename),
            root.join("assets/hooks/shared").join(filename),
        )
        .unwrap();
    }
    root
}
