"""Public installed/archive CLI layouts; resolution failure is infrastructure.

Rust cli_main.rs dispatches no argv (or run) to run_collector. JS1.15.2 index.ts
starts Orchestrator with no command; JS1.16 installer/collector-daemon resolves
the packaged dist/index.js. Do not add an invented collect command.
"""
import json
from pathlib import Path


def inside(root, relative):
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        raise RuntimeError("infrastructure: runtime entry escapes package root")
    return path



def collection_mode(root, entry):
    processor = inside(root, "assets/hooks/qoder-hook-processor.mjs")
    wrapper = inside(root, "assets/hooks/qoder-loongsuite-pilot-hook.sh")
    if processor.is_file() and wrapper.is_file():
        source = processor.read_text(encoding="utf-8")
        if ("appendRowsToHistory(" in source and "publishQoderWakeup" not in source
                and b"qoder-transcripts" not in entry.read_bytes()):
            return "legacy-stop"
    return "native"


def resolve(package, runtime=None, native_entry=None):
    package = Path(package).resolve()
    roots = [package]
    pointer = package / "current"
    if pointer.is_file():
        name = pointer.read_text().strip()
        if name and Path(name).name == name:
            roots.insert(0, package / "versions" / name)
    if (package / "package").is_dir():
        roots.append(package / "package")
    roots.extend(value for value in package.iterdir() if value.is_dir() and value not in roots)
    errors = []
    for root in roots:
        if runtime != "js":
            entries = [native_entry] if native_entry else ["bin/loongsuite-pilot", "loongsuite-pilot"]
            for relative in entries:
                entry = inside(root, relative)
                if not entry.is_file():
                    continue
                with entry.open("rb") as stream:
                    magic = stream.read(4)
                if magic != b"\x7fELF":
                    continue  # legacy JS shell launcher is not the native host
                library = entry.with_name("libloongsuite_pilot.so")
                if not library.is_file():
                    raise RuntimeError("infrastructure: native host is missing its matching adjacent SDK")
                with library.open("rb") as stream:
                    if stream.read(4) != b"\x7fELF":
                        raise RuntimeError("infrastructure: adjacent SDK is not a Linux ELF library")
                return {"runtime": "rust", "package": root, "entry": entry.relative_to(root).as_posix(),
                        "library": library.relative_to(root).as_posix()}
        if runtime == "rust":
            continue
        metadata = root / "package.json"
        if not metadata.is_file():
            continue
        value = json.loads(metadata.read_text())
        if value.get("name") != "loongsuite-pilot":
            continue
        declared = value.get("bin", {})
        declared = declared.get("loongsuite-pilot") if isinstance(declared, dict) else declared
        choices = [declared, "dist/index.js"]
        for relative in choices:
            if not isinstance(relative, str) or not relative.endswith((".js", ".mjs", ".cjs")):
                continue
            entry = inside(root, relative)
            if entry.is_file():
                return {"runtime": "js", "package": root, "entry": entry.relative_to(root).as_posix(),
                        "library": None, "collection": collection_mode(root, entry)}
        errors.append("declared public JS CLI is absent")
    raise RuntimeError("infrastructure: public runtime layout unresolved; " + "; ".join(errors))
