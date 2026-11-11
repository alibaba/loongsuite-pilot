#!/usr/bin/env python3
"""Resolve public source/release provenance without treating infra as incompatibility."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import urllib.parse
import urllib.request
import urllib.error
from runtime_layout import resolve as resolve_layout

REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
STABLE = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def api(path):
    request = urllib.request.Request("https://api.github.com/" + path,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "pilot-public-performance"})
    token = os.environ.get("GH_TOKEN")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def key(tag):
    match = STABLE.fullmatch(tag)
    if not match:
        raise ValueError("not a stable release")
    return tuple(map(int, match.groups()))


def public_repository(name):
    if not REPOSITORY.fullmatch(name):
        raise ValueError("invalid public repository name")
    value = api("repos/" + name)
    if value.get("private") is not False or value.get("visibility") not in (None, "public"):
        raise ValueError("only public source can enter this workflow")


def resolve(repository, ref):
    value = api("repos/%s/commits/%s" % (repository, urllib.parse.quote(ref, safe="")))
    sha = value.get("sha", "")
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("public ref did not resolve to an exact commit")
    return sha


def source_runtime(repository, commit):
    path = "repos/%s/contents/Cargo.toml?ref=%s" % (repository, commit)
    try:
        value = api(path)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    else:
        if value.get("type") == "file":
            return "rust"
        raise RuntimeError("infrastructure: unexpected public Cargo.toml metadata")
    value = api("repos/%s/contents/package.json?ref=%s" % (repository, commit))
    if value.get("type") != "file":
        raise RuntimeError("infrastructure: public source runtime cannot be resolved")
    return "js"


def validate_history(history, repository):
    if not isinstance(history, dict) or history.get("schema") != 1 or history.get("repository") != repository:
        raise RuntimeError("infrastructure: invalid persistent history identity/schema")
    if not isinstance(history.get("nodes"), list):
        raise RuntimeError("infrastructure: persistent history nodes must be a list")
    return history


def load_history(path, repository):
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("invalid history repository")
    empty = {"schema": 1, "repository": repository, "nodes": []}
    if path and path.exists():
        return validate_history(json.loads(path.read_text()), repository)
    if not path:
        return empty
    try:
        # Resolve mutable branch identity through the API first. An immutable
        # raw URL cannot return yesterday's branch history from a CDN cache.
        commit = resolve(repository, "sdk-performance-results")
        url = "https://raw.githubusercontent.com/%s/%s/history.json" % (repository, commit)
        with urllib.request.urlopen(url, timeout=30) as response:
            history = validate_history(json.load(response), repository)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        history = empty
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(history))
    return history


def stable_releases(repository):
    releases = []
    page = 1
    while True:
        batch = api("repos/%s/releases?per_page=100&page=%s" % (repository, page))
        if not isinstance(batch, list):
            raise RuntimeError("infrastructure: unexpected public release page")
        releases.extend(value for value in batch if not value["draft"] and not value["prerelease"]
                        and STABLE.fullmatch(value["tag_name"]))
        if len(batch) < 100:
            break
        page += 1
    releases.sort(key=lambda value: key(value["tag_name"]), reverse=True)
    return releases


QODER_STANDARD_METHOD = "github-full-pilot-qoder-native-10s-v1"
CODEX_STANDARD_METHOD = "github-full-pilot-codex-rollout-10s-v1"
QODER_MIXED_METHOD = "github-full-pilot-qoder-native-v2"
QODER_FIXED_30S_METHOD = "github-full-pilot-qoder-stop-30s-v1"
QODER_FIXED_30S_POLL_MS = 30_000
QODER_FIXED_30S_DRAIN_SECONDS = 45
CODEX_MIXED_METHOD = "github-full-pilot-codex-rollout-v2"


def history_for_method(history, method):
    if method is None or method == (history.get("method") or {}).get("id"):
        return history
    return history.get("other_methods", {}).get(method, {"nodes": []})


def select_backfill(repository, history, method=None):
    history = history_for_method(history, method)
    done = {node["id"] for node in history.get("nodes", [])
            if node.get("kind") == "release" and node.get("status") == "passed"}
    cutoff = (history.get("compatibility") or {}).get("excluded_at_or_before")
    for release in stable_releases(repository):
        if cutoff and key(release["tag_name"]) <= key(cutoff):
            break
        tag = "v" + ".".join(map(str, key(release["tag_name"])))
        if tag not in done:
            return release
    return None


def is_target_dev(repository, ref, history):
    configuration = history.get("configuration")
    branch = configuration.get("dev_branch") if isinstance(configuration, dict) else None
    return repository == "alibaba/loongsuite-pilot" and isinstance(branch, str) and bool(branch) and ref == branch


def download_release(repository, release, destination):
    candidates = [value for value in release.get("assets", []) if value["name"].endswith(".tar.gz")
                  and ("x86_64-unknown-linux-gnu" in value["name"] or value["name"] == "loongsuite-pilot.tar.gz")]
    candidates.sort(key=lambda value: ("x86_64-unknown-linux-gnu" not in value["name"], value["name"]))
    if not candidates:
        raise RuntimeError("artifact_unavailable: missing public Linux archive; not a compatibility cutoff")
    asset = candidates[0]
    digest = asset.get("digest") or ""
    if digest and not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("artifact_provenance_unavailable: unsupported published digest; not a compatibility cutoff")
    if type(asset.get("id")) is not int or asset["id"] <= 0 or type(asset.get("size")) is not int or not 0 < asset["size"] <= 512 * 1024 * 1024:
        raise ValueError("invalid public release asset identity/size")
    expected_url = "https://github.com/%s/releases/download/" % repository
    if not asset["browser_download_url"].startswith(expected_url):
        raise ValueError("unexpected public release asset origin")
    archive = destination / "release.tar.gz"
    checksum = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(asset["browser_download_url"], timeout=60) as response, archive.open("wb") as output:
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > asset["size"] or total > 512 * 1024 * 1024:
                raise ValueError("public release archive exceeds declared size")
            checksum.update(block); output.write(block)
    if total != asset["size"] or (digest and checksum.hexdigest() != digest.split(":", 1)[1]):
        raise ValueError("public release asset size/SHA mismatch")
    unpacked = destination / "package"
    unpacked.mkdir()
    if not hasattr(tarfile, "data_filter"):
        raise RuntimeError("infrastructure: Python tar data filter unavailable")
    with tarfile.open(archive, "r:gz") as stream:
        stream.extractall(unpacked, filter="data")
    layout = resolve_layout(unpacked)
    return {"runtime": layout["runtime"], "package": str(layout["package"]),
            "native_entry": layout["entry"] if layout["runtime"] == "rust" else "",
            "entry": layout["entry"], "asset_sha256": checksum.hexdigest(),
            "asset_id": asset["id"], "asset_name": asset["name"], "asset_size_bytes": total,
            "asset_url": asset["browser_download_url"],
            "checksum_source": "github_asset_digest" if digest else "download"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default="alibaba/loongsuite-pilot")
    parser.add_argument("--mode", choices=("main", "dev", "release", "backfill"), required=True)
    parser.add_argument("--ref", default="main")
    parser.add_argument("--benchmark-method", choices=(QODER_MIXED_METHOD, CODEX_MIXED_METHOD, QODER_FIXED_30S_METHOD),
                        default=QODER_MIXED_METHOD)
    parser.add_argument("--history", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--history-repository", default="alibaba/loongsuite-pilot")
    args = parser.parse_args()
    if args.benchmark_method == QODER_FIXED_30S_METHOD and (
            args.mode != "release" or not STABLE.fullmatch(args.ref)
            or not (1, 10, 0) <= key(args.ref) <= (1, 14, 0)):
        parser.error("the fixed 30s Qoder method is for the verified v1.10.0–v1.14.0 stable releases")
    if args.benchmark_method == CODEX_MIXED_METHOD and args.mode == "backfill":
        parser.error("Codex requires an explicit public Rust ref or release; historical backfill is not enabled")
    args.output.mkdir(parents=True, exist_ok=True)
    public_repository(args.repository)
    if args.mode in ("release", "backfill") and args.repository != "alibaba/loongsuite-pilot":
        raise ValueError("formal release history accepts only official public upstream releases")
    history = load_history(args.history, args.history_repository)
    measured = history_for_method(history, args.benchmark_method)
    release = None
    if args.mode == "backfill":
        release = select_backfill(args.repository, history, args.benchmark_method)
        if release is None:
            (args.output / "selection.json").write_text(json.dumps({"complete": True}) + "\n")
            return
    elif args.mode == "release":
        if not STABLE.fullmatch(args.ref):
            raise ValueError("release target must be stable tag")
        release = api("repos/%s/releases/tags/%s" % (args.repository, urllib.parse.quote(args.ref, safe="")))
        if release["draft"] or release["prerelease"]:
            raise ValueError("draft/prerelease is not a formal history node")
    ref = release["tag_name"] if release else args.ref
    if release and any(node.get("kind") == "release" and node.get("status") == "passed"
                       and key(node["version"]) == key(ref) for node in measured["nodes"]):
        (args.output / "selection.json").write_text(json.dumps({"complete": True}) + "\n")
        return
    result = {"complete": False, "repository": args.repository, "ref": ref,
              "commit": resolve(args.repository, ref), "kind": "release" if release else args.mode,
              "version": ref if release else args.mode, "method_id": args.benchmark_method}
    result["is_target_dev"] = result["kind"] == "dev" and is_target_dev(args.repository, ref, history)
    if release:
        result.update(download_release(args.repository, release, args.output))
        result["release_url"] = release["html_url"]
    else:
        result["runtime"] = source_runtime(args.repository, result["commit"])
    if args.benchmark_method == CODEX_MIXED_METHOD and result["runtime"] != "rust":
        raise ValueError("Codex performance method requires a public Rust host and adjacent SDK")
    (args.output / "selection.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
