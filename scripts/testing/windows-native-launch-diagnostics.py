#!/usr/bin/env python3
"""Developer-only Windows launch probes. Python is never a Pilot runtime dependency."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

OS_KEYS = ["SystemRoot", "WINDIR", "ComSpec", "ProgramFiles",
           "ProgramFiles(x86)", "ProgramW6432", "PATHEXT"]
PAYLOAD = b"\xef\xbb\xbf" + "raw \u4e2d\u6587\U0001f680".encode("utf-8") + b"\r\n\x00after-nul\n"
OUTPUT = b"PILOT_NATIVE_RAW:" + PAYLOAD
VALUES = ["pilot-argument-values", "", "space argument", 'quote"inside',
          "trailing space \\", "\u4e2d\u6587\U0001f680", "O'Brien",
          'C:\\space dir\\quote"and-slash\\', "literal %PILOT_EXPAND_CANARY%",
          "literal $() ; & | ^ < >"]
METHODS = ["start-process", "direct-array", "direct-legacy", "stop-parsing"]
PROBE = r'''
import json, os, subprocess, sys, time
from pathlib import Path
mode = sys.argv[1]
if mode == "descendant":
    started = Path(os.environ["PILOT_DESCENDANT_STARTED"])
    done = Path(os.environ["PILOT_DESCENDANT_DONE"])
    started.write_text("started", encoding="ascii")
    time.sleep(4)
    done.write_text("done", encoding="ascii")
    sys.exit(0)
data = sys.stdin.buffer.read()
if mode == "detached":
    subprocess.Popen(
        [sys.executable, "-I", "-S", __file__, "descendant"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                      | subprocess.CREATE_NO_WINDOW,
    )
Path(os.environ["PILOT_NATIVE_RECORD"]).write_text(
    json.dumps({"argv": sys.argv, "stdin_hex": data.hex()}, ensure_ascii=True),
    encoding="ascii",
)
sys.stdout.buffer.write(b"PILOT_NATIVE_RAW:" + data)
sys.stdout.buffer.flush()
sys.exit(17 if mode == "exit-17" else 0)
'''


def ps_literal(value):
    return "'" + value.replace("'", "''") + "'"


def crt_quoted(value):
    # Always quote one argument, using the same CRT rules as the service bridge.
    escaped = re.sub(r'(\\*)"', lambda m: m.group(1) * 2 + '\\"', value)
    escaped = re.sub(r"(\\+)$", lambda m: m.group(1) * 2, escaped)
    return '"' + escaped + '"'


def source(method, constrained, arguments):
    prelude = [
        "$ErrorActionPreference = 'Stop'",
        "$global:LASTEXITCODE = 9009",
    ]
    if constrained:
        prelude += [
            "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'",
            "$blocked = $false",
            "try { $null = [IO.File]::Exists('PILOT_CLM_CANARY') } catch {",
            "  if ($_.FullyQualifiedErrorId -notmatch 'ConstrainedLanguage') { throw }",
            "  $blocked = $true",
            "}",
            "if (-not $blocked) { throw 'CLM canary unexpectedly allowed a forbidden method' }",
        ]
    for module in ["Utility", "Management"]:
        name = "Microsoft.PowerShell." + module
        prelude.append("Import-Module -Name ($PSHOME + '\\Modules\\" + name
                       + "\\" + name + ".psd1') -ErrorAction Stop")
    values = [crt_quoted(value) for value in arguments] if method in [
        "start-process", "direct-legacy"] else arguments
    prelude.append("$nativeArgs = @(" + ",".join(ps_literal(v) for v in values) + ")")
    prelude += ["$nativeExit = $null", "$exception = ''", "try {"]
    if method == "start-process":
        prelude += [
            "  $p = Start-Process -FilePath $env:PILOT_LAUNCH_BINARY -ArgumentList $nativeArgs -NoNewWindow -PassThru -ErrorAction Stop",
            "  $null = $p.Handle",
            "  Wait-Process -InputObject $p -ErrorAction Stop",
            "  $nativeExit = $p.ExitCode",
        ]
    else:
        if method == "direct-legacy":
            prelude.append("  $PSNativeCommandArgumentPassing = 'Legacy'")
        if method == "stop-parsing":
            prelude.append("  & $env:PILOT_LAUNCH_BINARY --% %PILOT_RAW_ARGS%")
        else:
            prelude.append("  & $env:PILOT_LAUNCH_BINARY @nativeArgs")
        prelude.append("  $nativeExit = $global:LASTEXITCODE")
    prelude += [
        "} catch { $exception = [string]$_.FullyQualifiedErrorId + ': ' + [string]$_.Exception.Message }",
        "$diagnostic = @{ nativeExit=$nativeExit; exception=$exception; language=[string]$ExecutionContext.SessionState.LanguageMode }",
        "$diagnostic | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:PILOT_NATIVE_DIAGNOSTIC -Encoding UTF8",
        "if ($null -eq $nativeExit -or $exception) { exit 98 }",
        "exit $nativeExit",
    ]
    return "\n".join(prelude) + "\n"


def run_case(shell, method, constrained, scenario, directory, timeout):
    directory.mkdir()
    probe = directory / "probe \u4e2d\u6587\U0001f680.py"
    probe.write_text(PROBE, encoding="utf-8")
    script = directory / "launch.ps1"
    arguments = ["-I", "-S", str(probe), scenario] + VALUES
    script.write_text(source(method, constrained, arguments), encoding="utf-8-sig")
    record_path = directory / "record.json"
    diagnostic_path = directory / "diagnostic.json"
    started_path = directory / "descendant-started"
    done_path = directory / "descendant-done"
    env = {key: os.environ[key] for key in OS_KEYS if key in os.environ}
    env.update(
        HOME=str(directory), USERPROFILE=str(directory), TEMP=str(directory), TMP=str(directory),
        APPDATA=str(directory / "appdata"), LOCALAPPDATA=str(directory / "localappdata"),
        PATH=str(directory / "no-runtimes"), PSModulePath=str(directory / "no-modules"),
        PATHEXT=".EXE;.COM", PILOT_LAUNCH_BINARY=sys.executable,
        PILOT_RAW_ARGS=subprocess.list2cmdline(arguments),
        PILOT_NATIVE_RECORD=str(record_path), PILOT_NATIVE_DIAGNOSTIC=str(diagnostic_path),
        PILOT_DESCENDANT_STARTED=str(started_path), PILOT_DESCENDANT_DONE=str(done_path),
        PILOT_EXPAND_CANARY="UNEXPECTED_RECURSIVE_EXPANSION",
    )
    started = time.monotonic()
    child = subprocess.Popen(
        [str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", str(script)],
        cwd=str(directory), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    timed_out = False
    try:
        out, err = child.communicate(input=PAYLOAD, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        child.kill()
        try:
            out, err = child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            out, err = b"", b""
            child.stdout.close()
            child.stderr.close()
            child.wait(timeout=1)
    duration_ms = round((time.monotonic() - started) * 1000)
    record = json.loads(record_path.read_text(encoding="utf-8")) if record_path.exists() else None
    diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8-sig")) if diagnostic_path.exists() else None
    expected_exit = 17 if scenario == "exit-17" else 0
    result = {
        "shell": shell.name, "language": "ConstrainedLanguage" if constrained else "FullLanguage",
        "method": method, "scenario": scenario, "duration_ms": duration_ms,
        "timeout_seconds": timeout, "timed_out": timed_out, "exit_code": child.returncode,
        "native_exit": diagnostic.get("nativeExit") if diagnostic else None,
        "exception": diagnostic.get("exception") if diagnostic else "no diagnostic",
        "language_preserved": bool(diagnostic and diagnostic["language"] == (
            "ConstrainedLanguage" if constrained else "FullLanguage")),
        "argv_exact": bool(record and record["argv"] == [str(probe), scenario] + VALUES),
        "stdin_exact": bool(record and record["stdin_hex"] == PAYLOAD.hex()),
        "stdout_exact": out == OUTPUT, "stdout_hex": out[:200].hex(),
        "stderr_bytes": len(err), "stderr_preview": err[:1000].decode("utf-8", "replace"),
    }
    if scenario == "detached":
        result["descendant_done_when_shell_exited"] = done_path.exists()
        deadline = time.monotonic() + 1
        while not started_path.exists() and not done_path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        result["descendant_started"] = started_path.exists()
        result["did_not_wait_for_descendant"] = (
            started_path.exists() and not result["descendant_done_when_shell_exited"])
    result["ok"] = (
        not timed_out and child.returncode == expected_exit and not err
        and result["native_exit"] == expected_exit and not result["exception"]
        and result["language_preserved"] and result["argv_exact"] and result["stdin_exact"]
        and result["stdout_exact"] and (scenario != "detached" or result["did_not_wait_for_descendant"])
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=float, default=20)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("requires a Windows diagnostic runner")
    if not 0 < args.timeout_seconds <= 20:
        parser.error("timeout must be in (0, 20]")
    pwsh = shutil.which("pwsh.exe")
    if not pwsh:
        parser.error("PowerShell 7 is required")
    shells = [Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe", Path(pwsh)]
    if not all(shell.is_file() for shell in shells):
        parser.error("PowerShell 5.1 and 7 are both required")
    root = Path(tempfile.mkdtemp(prefix="pilot-native-launch-"))
    results = []
    try:
        def task(shell, method, constrained, scenario):
            directory = root / (shell.name + "-" + str(constrained) + "-" + method + "-" + scenario)
            try:
                return run_case(shell, method, constrained, scenario, directory, args.timeout_seconds)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                return {"shell": shell.name, "constrained": constrained,
                        "method": method, "scenario": scenario,
                        "diagnostic_error": type(error).__name__, "message": str(error), "ok": False}

        # Four independent fixture processes keep even timeout-heavy hypothesis
        # probes inside the six-minute diagnostic job. Each retains its own 20s cap.
        with ThreadPoolExecutor(max_workers=4) as executor:
            pending = [executor.submit(task, shell, method, constrained, scenario)
                       for shell in shells for constrained in [False, True]
                       for method in METHODS for scenario in ["exit-0", "exit-17", "detached"]]
            for future in as_completed(pending):
                result = future.result()
                results.append(result)
                print(json.dumps(result, ensure_ascii=True), flush=True)
        summary = {"summary": True, "cases": len(results), "methods": {}}
        for method in METHODS:
            cases = [result for result in results if result["method"] == method]
            summary["methods"][method] = {"passed": sum(result["ok"] for result in cases), "cases": len(cases)}
        print(json.dumps(summary), flush=True)
        # Hypothesis probes intentionally report failed candidates; completing
        # all 48 controlled cases, rather than a candidate's success, is the gate.
        return 0 if len(results) == 48 and not any("diagnostic_error" in r for r in results) else 1
    finally:
        # Every detached fixture is bounded to four seconds; allow it to finish
        # before deleting its private directory. This is outside each case budget.
        time.sleep(4.2)
        shutil.rmtree(str(root))


if __name__ == "__main__":
    sys.exit(main())
