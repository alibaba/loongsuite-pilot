#!/usr/bin/env python3
"""Execute production Windows PS bootstraps without mutable PATH/module lookup."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

OS_KEYS = [
    "SystemRoot", "WINDIR", "ComSpec", "ProgramData", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "PATHEXT",
]
TOKEN = "PILOT_MODULE_BOOTSTRAP_OK"

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

def environment(root):
    result = {key: os.environ[key] for key in OS_KEYS if key in os.environ}
    result.update(
        HOME=str(root), USERPROFILE=str(root), APPDATA=str(root / "appdata"),
        LOCALAPPDATA=str(root / "localappdata"), TMP=str(root), TEMP=str(root),
        PATH=str(root / "no-runtimes"), PSModulePath=str(root / "no-modules"),
        LOONGSUITE_PILOT_DATA_DIR=str(root / "data"),
        LOONGSUITE_PILOT_CACHE_DIR=str(root / "cache"),
        LOONGSUITE_PILOT_BIN=str(root / "missing-native.exe"),
        PILOT_MODULE_MARKER=str(root / "module-marker"),
    )
    return result

def run_case(shell, constrained, operation, repo, root, timeout):
    case = root / (shell.stem + "-" + str(constrained) + "-" + operation)
    case.mkdir()
    marker = case / "module-marker"
    mode = "ConstrainedLanguage" if constrained else "FullLanguage"
    source = "$ErrorActionPreference = 'Stop'\n"
    if constrained:
        source += "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n"
        source += (
            "$blocked=$false\n"
            "try { $null=[IO.File]::Exists('PILOT_CLM_CANARY') } "
            "catch { if ($_.FullyQualifiedErrorId -notmatch 'ConstrainedLanguage') {throw};$blocked=$true }\n"
            "if (-not $blocked) {throw 'ConstrainedLanguage canary failed'}\n"
        )
    if operation == "shared":
        source += ". " + quote(repo / "assets/hooks/shared/native.ps1") + "\n"
        source += (
            "if ($ExecutionContext.SessionState.LanguageMode -ne " + quote(mode) + ") {throw 'language changed'}\n"
            "$v=Write-Output " + quote(TOKEN) + "\n"
            "$path=Join-Path $env:HOME 'child'\n"
            "$json=@{value=$v;path=$path}|ConvertTo-Json -Compress\n"
            "if ($json -notmatch " + quote(TOKEN) + ") {throw 'JSON pipeline failed'}\n"
            "Set-Content -LiteralPath $env:PILOT_MODULE_MARKER -Value 'complete' -Encoding UTF8\n"
            "Write-Output $v\n"
        )
    else:
        hooks = case / "hooks"
        (hooks / "shared").mkdir(parents=True)
        shutil.copyfile(repo / "assets/hooks/shared/native.ps1", hooks / "shared/native.ps1")
        shutil.copyfile(repo / "assets/hooks/codex-loongsuite-pilot-hook.ps1", hooks / "codex-loongsuite-pilot-hook.ps1")
        source += "& " + quote(hooks / "codex-loongsuite-pilot-hook.ps1") + " stop\n"
    script = case / "fixture.ps1"
    script.write_text("\ufeff" + source, encoding="utf-8")
    env = environment(case)
    started = time.monotonic()
    child = subprocess.Popen(
        [str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        cwd=str(case), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    timed_out = False
    try:
        stdout, stderr = child.communicate(b"{}", timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        child.kill()
        stdout, stderr = child.communicate(timeout=2)
    output = stdout.decode("utf-8-sig", "replace").strip()
    errors = stderr.decode("utf-8-sig", "replace")
    ok = not timed_out and child.returncode == 0
    if operation == "shared":
        ok = ok and output == TOKEN and not stderr and marker.is_file() and marker.read_text(encoding="utf-8-sig").strip() == "complete"
    else:
        ok = ok and output == "{}" and "native hook unavailable" in errors
        ok = ok and not (case / "data").exists() and not (case / "cache").exists()
    row = {
        "shell": shell.name, "language": mode, "operation": operation,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "timeout_seconds": timeout, "timed_out": timed_out,
        "exit_code": child.returncode, "stdout_bytes": len(stdout),
        "stderr_bytes": len(stderr), "ok": bool(ok),
    }
    if not ok:
        row["failure_stdout"] = output[:1000]
        row["failure_stderr"] = errors[:2000]
    return row

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--timeout-seconds", type=float, default=20)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Windows-only contract; not a Linux platform proof")
    if not 0 < args.timeout_seconds <= 20:
        parser.error("cannot exceed the existing 20-second native Hook budget")
    legacy = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    modern = shutil.which("pwsh.exe")
    if not legacy.is_file() or not modern:
        parser.error("both Windows PowerShell 5.1 and PowerShell 7 are required")
    results = []
    with tempfile.TemporaryDirectory(prefix="pilot-module-bootstrap-") as raw:
        for shell in [legacy, Path(modern)]:
            for constrained in [False, True]:
                for operation in ["shared", "wrapper"]:
                    row = run_case(shell, constrained, operation, args.repo, Path(raw), args.timeout_seconds)
                    results.append(row)
                    print(json.dumps(row, ensure_ascii=True), flush=True)
    raise SystemExit(0 if all(row["ok"] for row in results) else 1)

if __name__ == "__main__":
    main()
