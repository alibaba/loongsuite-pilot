#!/usr/bin/env python3
"""Verify an existing GNU package on glibc2.34, using only a synthetic HOME."""
import argparse
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import uuid
from pathlib import Path

IMAGES = {
    "x86_64-unknown-linux-gnu": (
        "linux/amd64",
        "quay.io/rockylinux/rockylinux@sha256:ed654c694190a670bb5c33f68995b862214fc96ffbdca95e07a8935ba0a3717d",
    ),
    "aarch64-unknown-linux-gnu": (
        "linux/arm64",
        "quay.io/rockylinux/rockylinux@sha256:67492e5a371d9db7c2ffb2708abae92147fb900900832a7ed3fb2ac4df9ec052",
    ),
}

def snapshot(root):
    out = {}
    for path in [root] + sorted(root.rglob("*")):
        mode = path.lstat().st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError("package/preflight HOME contains nonregular entry")
        digest = None
        if path.is_file():
            hasher = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    hasher.update(block)
            digest = hasher.hexdigest()
        out[str(path.relative_to(root))] = (stat.S_IMODE(mode), digest)
    return out

def arguments(package, home, target, name, command):
    platform, image = IMAGES[target]
    result = ["docker", "run", "--rm", "--name", name, "--platform", platform,
              "--network", "none", "--user", str(os.getuid()) + ":" + str(os.getgid()),
              "--mount", "type=bind,src=" + str(package) + ",dst=" + str(package) + ",readonly",
              "--mount", "type=bind,src=" + str(home) + ",dst=" + str(home) + ",readonly",
              "--workdir", str(package)]
    env = {
        "HOME": str(home), "USERPROFILE": str(home), "PATH": str(home / "no-runtimes"),
        "LOONGSUITE_PILOT_RESOURCE_ROOT": str(package),
        "LOONGSUITE_PILOT_DATA_DIR": str(home / "data"),
        "LOONGSUITE_PILOT_CACHE_DIR": str(home / "cache"),
        "AGENT_DATA_COLLECTION_CONFIG": str(home / "config.json"),
    }
    for key in ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]:
        env[key] = str(home / key.lower())
    for key, value in env.items():
        result += ["--env", key + "=" + value]
    result += ["--entrypoint", str(package / "bin/loongsuite-pilot"), image] + command
    return result

def bounded_container(argv, name, allow_info=False):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=35, check=True)
        if len(result.stdout) > 1024 * 1024 or len(result.stderr) > 1024 * 1024:
            raise ValueError("native preflight output exceeds limit")
        if result.stderr:
            if not allow_info:
                raise ValueError("unexpected native preflight stderr")
            for line in result.stderr.decode("utf-8").splitlines():
                record = json.loads(line)
                if not isinstance(record, dict) or record.get("level") not in ("INFO", "DEBUG"):
                    raise ValueError("native preflight emitted a warning or invalid diagnostic")
        return result.stdout.decode("utf-8")
    finally:
        # Exact UUID name; no installed service/container scans or stop commands.
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=False)

def verify(package, evidence):
    package = package.resolve(strict=True)
    manifest = json.loads((package / "runtime-manifest.json").read_text())
    target = manifest["target"]
    platform, image = IMAGES[target]
    if manifest["runtime"] != "rust" or manifest["binary"] != "bin/loongsuite-pilot":
        raise ValueError("not a native GNU Pilot package")
    # Require an explicitly prepared local image. No silent tag or pull fallback.
    subprocess.run(["docker", "image", "inspect", image], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    glibc_name = "pilot-glibc-proof-" + uuid.uuid4().hex
    glibc = bounded_container(
        ["docker", "run", "--rm", "--name", glibc_name, "--platform", platform,
         "--network", "none", "--entrypoint", "/usr/bin/getconf", image, "GNU_LIBC_VERSION"],
        glibc_name,
    ).strip()
    if glibc != "glibc 2.34":
        raise ValueError("runtime image glibc mismatch")
    with tempfile.TemporaryDirectory(prefix="pilot-container-preflight-") as directory:
        home = Path(directory)
        config = {"enabled": False, "autoUpdate": {"enabled": False},
                  "jsonl": {"enabled": False}, "http": {"enabled": False},
                  "sls": {"enabled": False}, "otlpTrace": {"enabled": False}}
        (home / "config.json").write_text(json.dumps(config))
        before_home = snapshot(home)
        before_package = snapshot(package)
        def invoke(command):
            name = "pilot-native-proof-" + uuid.uuid4().hex
            return bounded_container(arguments(package, home, target, name, command), name, allow_info=command == ["check", "--json"])
        if invoke(["--version"]).strip() != "loongsuite-pilot " + manifest["version"]:
            raise ValueError("native version mismatch")
        if invoke(["probe", "--build-edition"]).strip() != manifest["edition"]:
            raise ValueError("native edition mismatch")
        check = json.loads(invoke(["check", "--json"]))
        for key, value in [("schema", 1), ("ok", True), ("runtime", "rust"),
                           ("version", manifest["version"]), ("target", target),
                           ("edition", manifest["edition"])]:
            if check.get(key) != value:
                raise ValueError("native preflight protocol mismatch: " + key)
        if check["check"]["details"]["gitCommit"] != manifest["gitCommit"]:
            raise ValueError("native commit mismatch")
        if snapshot(home) != before_home or snapshot(package) != before_package:
            raise ValueError("preflight modified synthetic home or package")
    result = {"ok": True, "glibc": glibc, "image": image, "target": target,
              "version": manifest["version"], "commit": manifest["gitCommit"],
              "commands": ["--version", "probe --build-edition", "check --json"],
              "home": "synthetic-only", "realInstallationTouched": False}
    evidence.write_text(json.dumps(result, indent=2) + "\n")
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.package_root, args.evidence)))
