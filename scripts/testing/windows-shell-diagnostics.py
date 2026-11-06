#!/usr/bin/env python3
"""Developer-only, bounded PowerShell pipeline diagnostics. Never used by Pilot."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TOKEN = "PILOT_SHELL_SENTINEL"
OS_KEYS = [
    "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "PATHEXT",
]
PAYLOADS = [
    ("console", "[Console]::WriteLine('" + TOKEN + "')"),
    ("capture-cmdlet", "$v=Write-Output '" + TOKEN + "';[IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'captured;');[Console]::WriteLine($v)"),
    ("literal-pipeline", "'" + TOKEN + "'"),
    ("cmdlet-pipeline", "Write-Output '" + TOKEN + "'"),
]


def script(body):
    return (
        "[IO.File]::WriteAllText($env:PILOT_STARTUP_DIAG,'entered;');"
        "try {" + body + ";"
        "[IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'complete;')"
        "} catch {"
        "[IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'caught;');exit 23"
        "}"
    )


def environment(root, shell, mode, marker):
    result = dict(os.environ) if mode == "inherited" else {
        key: os.environ[key] for key in OS_KEYS if key in os.environ
    }
    result.update(
        HOME=str(root), USERPROFILE=str(root),
        APPDATA=str(root / "appdata"), LOCALAPPDATA=str(root / "localappdata"),
        PILOT_STARTUP_DIAG=str(marker),
    )
    if mode != "inherited":
        result["PATH"] = str(root / "no-runtimes")
    if mode == "builtin-modules":
        result["PSModulePath"] = str(shell.parent / "Modules")
    if mode == "cache-disabled":
        result["PSModulePath"] = str(shell.parent / "Modules")
        result["PSModuleAnalysisCachePath"] = "NUL"
    elif mode == "minimal-os-path":
        result["PSModulePath"] = str(shell.parent / "Modules")
        system_root = Path(os.environ["SystemRoot"])
        result["PATH"] = os.pathsep.join([
            str(root / "no-runtimes"), str(system_root / "System32"),
            str(system_root), str(shell.parent),
        ])
    elif mode == "system-drive-data":
        result["PSModulePath"] = str(shell.parent / "Modules")
        for key in ["SystemDrive", "ProgramData", "ALLUSERSPROFILE", "PUBLIC"]:
            if key in os.environ:
                result[key] = os.environ[key]
    return result


def run_case(shell, mode, payload, root, timeout):
    name, body = payload
    marker = root / (shell.name + "-" + mode + "-" + name + ".marker")
    started = time.monotonic()
    child = subprocess.Popen(
        [str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-Command", script(body)],
        cwd=str(root), env=environment(root, shell, mode, marker),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    timed_out = False
    output, errors = b"", b""
    try:
        output, errors = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        child.kill()
        try:
            output, errors = child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            child.stdout.close()
            child.stderr.close()
            child.wait(timeout=1)
    stage = marker.read_text() if marker.exists() else "absent"
    result = {
        "shell": shell.name, "environment": mode, "operation": name,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "timeout_seconds": timeout, "timed_out": timed_out, "exit_code": child.returncode,
        "stdout_contains_sentinel": TOKEN.encode("ascii") in output,
        "stdout_bytes": len(output), "stderr_bytes": len(errors), "stage": stage,
    }
    # Never log child output or environment values, including the inherited
    # control's CI credentials. Only this fixed script supplies stage markers.
    result["ok"] = (
        not timed_out and child.returncode == 0
        and result["stdout_contains_sentinel"] and not errors and stage.endswith("complete;")
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=float, default=5)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("requires a Windows development runner")
    if not 0 < args.timeout_seconds <= 20:
        parser.error("timeout must be in (0, 20]")
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    shells = [Path(system_root) / "System32/WindowsPowerShell/v1.0/powershell.exe"]
    pwsh = shutil.which("pwsh.exe")
    if pwsh:
        shells.append(Path(pwsh))
    failed = not bool(pwsh)
    if not pwsh:
        print(json.dumps({"shell": "pwsh.exe", "missing": True}), flush=True)
    root = Path(tempfile.mkdtemp(prefix="pilot-windows-shell-diagnostic-"))
    try:
        for shell in shells:
            if not shell.is_file():
                print(json.dumps({"shell": shell.name, "missing": True}), flush=True)
                failed = True
                continue
            for mode in ["inherited", "isolated", "builtin-modules"]:
                for payload in PAYLOADS:
                    try:
                        result = run_case(shell, mode, payload, root, args.timeout_seconds)
                    except (OSError, subprocess.SubprocessError) as error:
                        result = {"shell": shell.name, "environment": mode,
                                  "operation": payload[0], "error_type": type(error).__name__,
                                  "ok": False}
                    print(json.dumps(result, ensure_ascii=True), flush=True)
                    failed = failed or not result["ok"]

        # Keep the original 24-case baseline unchanged. These focused probes
        # distinguish command discovery, explicit import and cache/OS inputs.
        # They are hypotheses until the same bounded Windows run proves them.
        shell = shells[0]
        if shell.is_file():
            qualified = ("module-qualified", "Microsoft.PowerShell.Utility\\Write-Output '" + TOKEN + "'")
            explicit = (
                "explicit-utility",
                "[IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'before-import;');"
                "Microsoft.PowerShell.Core\\Import-Module -Name "
                "($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop;"
                "[IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'imported;');"
                "Write-Output '" + TOKEN + "'",
            )
            core = (
                "core-command",
                "$v=Microsoft.PowerShell.Core\\Get-Module -Name Microsoft.PowerShell.Utility;"
                "[IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'core-complete;');'" + TOKEN + "'",
            )
            probes = [("builtin-modules", payload) for payload in [qualified, explicit, core]]
            probes += [
                (mode, payload) for mode in ["cache-disabled", "minimal-os-path", "system-drive-data"]
                for payload in PAYLOADS if payload[0] in ["capture-cmdlet", "cmdlet-pipeline"]
            ]
            for mode, payload in probes:
                case_root = root / ("focused-" + mode + "-" + payload[0])
                case_root.mkdir()
                result = run_case(shell, mode, payload, case_root, args.timeout_seconds)
                result["focused_probe"] = True
                print(json.dumps(result, ensure_ascii=True), flush=True)
                failed = failed or not result["ok"]
    finally:
        try:
            shutil.rmtree(str(root))
        except OSError as error:
            print(json.dumps({"cleanup_error": type(error).__name__}), flush=True)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
