"""Offline contracts for plugin and adjacent, independently copied Skills.

Run with ``python3 -m unittest discover -s app/qoder-plugin/agentloop/tests -v``.
All executable fixtures, fake CLI calls and generated HTML stay in temporary
paths containing spaces. No real CLI, login, credential file or cloud is used.
PowerShell checks use local pwsh when available and do not claim Windows 5.1 runtime.
"""
import contextlib
from collections import Counter
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import unquote, urlsplit


PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parents[2]
RELATIVE_PLUGIN = PLUGIN.relative_to(REPO)
SKILLS = ("agentloop-audit-query", "agentloop-audit-dashboard",
          "sls-dashboard-builder", "agentloop-collector-setup")
CHILDREN = {
    "audit": ("agentloop-audit-query", "query.py"),
    "auth": ("agentloop-audit-query", "ensure_oauth.py"),
    "report": ("sls-dashboard-builder", "render_report.py"),
    "publish": ("sls-dashboard-builder", "publish_dashboard.py"),
    "install": ("agentloop-collector-setup", "install.py"),
}
TARGET = {"agentSpace": "demo-space", "regionId": "cn-test",
          "slsProject": "demo-project", "slsLogstore": "agent-event"}


def tracked_paths():
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", str(RELATIVE_PLUGIN)], cwd=REPO,
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return [Path(p) for p in result.stdout.decode().split("\0") if p]


def safe_source(path):
    """Inspect names before copying any tracked content."""
    name = path.name.lower()
    return not (name.startswith(".env") or name in {"credentials.json", "config.json"}
                or name.endswith((".pem", ".key")) or "aliyun" in path.parts
                or "__pycache__" in path.parts)


@contextlib.contextmanager
def working_directory(path):
    old = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


@contextlib.contextmanager
def import_script(path, query_scripts, fake_home):
    """Import one copied module without consulting any real home configuration."""
    prefixes = ("util", "ensure_oauth")
    saved_modules = {key: value for key, value in sys.modules.items()
                     if any(key == prefix or key.startswith(prefix + ".")
                            for prefix in prefixes)}
    for key in saved_modules:
        del sys.modules[key]
    old_path = list(sys.path)
    sys.path.insert(0, str(query_scripts))
    original_expand = os.path.expanduser

    def expand(value):
        if value == "~" or value.startswith("~/"):
            return str(fake_home) + value[1:]
        return original_expand(value)

    try:
        with mock.patch("os.path.expanduser", side_effect=expand), \
                mock.patch("urllib.request.urlopen", side_effect=AssertionError("Network forbidden")):
            spec = importlib.util.spec_from_file_location("layout_test_" + path.stem, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            yield module
    finally:
        sys.path[:] = old_path
        for key in list(sys.modules):
            if any(key == prefix or key.startswith(prefix + ".") for prefix in prefixes):
                del sys.modules[key]
        sys.modules.update(saved_modules)


class SkillLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentloop layout tests ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.plugin = self.base / "copied plugin with spaces"
        for relative in tracked_paths():
            source = REPO / relative
            if source.is_file() and safe_source(relative):
                dest = self.plugin / relative.relative_to(RELATIVE_PLUGIN)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, dest)
        self.standalone = self.base / "independent skills with spaces"
        shutil.copytree(self.plugin / "skills", self.standalone)
        self.business = self.base / "business project with spaces"
        self.business.mkdir()
        self.fake_home = self.base / "unused fake home"
        self.fake_home.mkdir()

    def forms(self):
        return [("plugin", self.plugin, self.plugin / "skills"),
                ("standalone", self.standalone, self.standalone)]

    def query_scripts(self, skills):
        return skills / "agentloop-audit-query" / "scripts"

    def routers(self):
        return [("plugin-compat", self.plugin / "scripts" / "run.py", self.plugin / "skills"),
                ("plugin-skill", self.query_scripts(self.plugin / "skills") / "run.py", self.plugin / "skills"),
                ("standalone-skill", self.query_scripts(self.standalone) / "run.py", self.standalone)]

    def stub_children(self, skills):
        for command, (skill, filename) in CHILDREN.items():
            path = skills / skill / "scripts" / filename
            self.assertTrue(path.is_file(), "Missing migrated child: " + str(path))
            path.write_text('''import json, os, sys
from pathlib import Path
command = ''' + repr(command) + '''
trace = Path(os.environ["SKILL_LAYOUT_TRACE"])
previous = [json.loads(x) for x in trace.read_text().splitlines()] if trace.exists() else []
row = {"command": command, "argv": sys.argv[1:], "cwd": os.getcwd()}
with trace.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(row, ensure_ascii=False) + "\\n")
print("CHILD=" + json.dumps(row, ensure_ascii=False), flush=True)
print("child-stderr-" + command, file=sys.stderr)
if os.environ.get("SKILL_LAYOUT_RETRY") and command != "auth":
    sys.exit(0 if any(x["command"] == "auth" for x in previous) else 3)
sys.exit(int(os.environ.get("SKILL_LAYOUT_RC", "0")))
''', encoding="utf-8")

    def invoke_router(self, router, command, args, rc=0, retry=False):
        trace = self.base / "fake child trace.jsonl"
        if trace.exists():
            trace.unlink()
        env = dict(os.environ)
        env.update(PYTHONDONTWRITEBYTECODE="1", SKILL_LAYOUT_TRACE=str(trace),
                   SKILL_LAYOUT_RC=str(rc), SKILL_LAYOUT_RETRY="1" if retry else "")
        result = subprocess.run([sys.executable, str(router), command, *args],
                                cwd=self.business, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        rows = [json.loads(x) for x in trace.read_text().splitlines()] if trace.exists() else []
        return result, rows

    def test_all_python_routes_preserve_arguments_stdout_and_cwd(self):
        args = ["--query", 'a "quoted" value 中文', "two words", "--value=-9", ""]
        for label, router, skills in self.routers():
            self.stub_children(skills)
            for command in CHILDREN:
                with self.subTest(layout=label, command=command):
                    result, rows = self.invoke_router(router, command, args)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(rows, [{"command": command, "argv": args, "cwd": str(self.business)}])
                    self.assertIn("CHILD=", result.stdout)
                    self.assertIn("child-stderr-" + command, result.stderr)

    def test_all_python_routes_preserve_non_auth_failure(self):
        for label, router, skills in self.routers():
            self.stub_children(skills)
            for command in CHILDREN:
                with self.subTest(layout=label, command=command):
                    result, rows = self.invoke_router(router, command, ["one value"], rc=17)
                    self.assertEqual(result.returncode, 17, result.stderr)
                    self.assertEqual([r["command"] for r in rows], [command])

    def test_exit_three_authenticates_then_retries_original_call(self):
        args = ["--query", 'select "a b"', "--from", "100", "--to", "200", ""]
        for label, router, skills in self.routers():
            self.stub_children(skills)
            for command in (c for c in CHILDREN if c != "auth"):
                with self.subTest(layout=label, command=command):
                    result, rows = self.invoke_router(router, command, args, retry=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual([r["command"] for r in rows], [command, "auth", command])
                    self.assertEqual([r["argv"] for r in rows], [args, [], args])
                    self.assertTrue(all(r["cwd"] == str(self.business) for r in rows))
                    self.assertEqual(result.stdout.count("CHILD="), 2)
                    self.assertNotIn('"command": "auth"', result.stdout)

    def test_direct_auth_exit_three_does_not_recurse(self):
        for label, router, skills in self.routers():
            self.stub_children(skills)
            with self.subTest(layout=label):
                result, rows = self.invoke_router(router, "auth", ["--auth-mode", "AK"], rc=3)
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertEqual([r["command"] for r in rows], ["auth"])

    def test_auth_failure_stops_the_original_retry(self):
        for label, router, skills in self.routers():
            self.stub_children(skills)
            with self.subTest(layout=label):
                result, rows = self.invoke_router(router, "audit", ["original argument"], rc=17, retry=True)
                self.assertEqual(result.returncode, 17, result.stderr)
                self.assertEqual([r["command"] for r in rows], ["audit", "auth"])

    def test_get_logs_v2_cli_body_and_auth_roots(self):
        query = '* | SELECT "quoted field" WHERE x=\'中文 value\''
        for label, root, skills in self.forms():
            scripts = self.query_scripts(skills)
            with self.subTest(layout=label), import_script(scripts / "util" / "aliyun.py", scripts, self.fake_home) as module:
                expected_home = root / "aliyun" if label == "plugin" else skills / "agentloop-audit-query" / "aliyun"
                self.assertEqual(Path(module.aliyun_config_path()), expected_home / "config.json")
                calls = []

                def fake_run(command, **kwargs):
                    calls.append(command)
                    return subprocess.CompletedProcess(command, 0, stdout='{"data": [{"ok": "yes"}], "meta": {"progress": "Complete"}}', stderr="")

                with mock.patch.object(module, "aliyun_bin", return_value="fake-aliyun"), \
                        mock.patch.object(module.subprocess, "run", side_effect=fake_run):
                    actual = module.get_logs("test-profile", TARGET, query, 100, 200, 37, 4)
                self.assertEqual(actual["data"], [{"ok": "yes"}])
                self.assertEqual(len(calls), 1)
                argv = calls[0]
                self.assertEqual(argv[:2], ["fake-aliyun", "sls"])
                self.assertIn("GetLogsV2", argv)
                self.assertEqual(argv[argv.index("--config-path") + 1], str(expected_home / "config.json"))
                self.assertEqual(argv[argv.index("--profile") + 1], "test-profile")
                self.assertEqual(argv[argv.index("--region") + 1], TARGET["regionId"])
                self.assertEqual(argv[argv.index("--project") + 1], TARGET["slsProject"])
                self.assertEqual(argv[argv.index("--logstore") + 1], TARGET["slsLogstore"])
                self.assertEqual(json.loads(argv[argv.index("--body") + 1]),
                                 {"from": 100, "to": 200, "query": query,
                                  "line": 37, "offset": 4, "reverse": True})
                self.assertFalse(expected_home.exists(), "A fake CLI check must not create an auth directory")

    def dashboard_fixture(self):
        path = self.business / "report with spaces-dashboard.json"
        path.write_text(json.dumps({
            "dashboardName": "layout-test", "displayName": "Layout test",
            "charts": [{"title": "items", "type": "tablepro",
                        "display": {"basicOptions": {"displayName": "Items"},
                                    "xPos": 0, "yPos": 0, "width": 24, "height": 5},
                        "search": {"chartQueries": [{"name": "A", "project": "",
                                                      "logstore": "", "query": "* | SELECT 7 AS amount"}]}}]
        }, ensure_ascii=False), encoding="utf-8")
        return path

    def test_builder_renders_html_with_shared_query_auth(self):
        for label, root, skills in self.forms():
            scripts = self.query_scripts(skills)
            renderer = skills / "sls-dashboard-builder" / "scripts" / "render_report.py"
            with self.subTest(layout=label), import_script(renderer, scripts, self.fake_home) as module:
                source = Path(sys.modules["util.aliyun"].__file__)
                self.assertEqual(source, scripts / "util" / "aliyun.py")
                calls = []

                def fake_cli(profile, region, argv):
                    calls.append((profile, region, argv))
                    return {"data": [{"label": "演示结果", "amount": "7"}], "meta": {"progress": "Complete"}}, ""

                dashboard = self.dashboard_fixture()
                with mock.patch.object(module, "require_profile", return_value="shared-profile"), \
                        mock.patch.object(module, "load_target", return_value=TARGET), \
                        mock.patch.object(module, "aliyun", side_effect=fake_cli), \
                        mock.patch.object(sys, "argv", [str(renderer), "--dashboard", str(dashboard), "--from", "100", "--to", "200"]), \
                        working_directory(self.business), contextlib.redirect_stdout(io.StringIO()):
                    module.main()
                output = dashboard.with_name("report with spaces-report.html")
                self.assertTrue(output.is_file())
                self.assertIn("演示结果", output.read_text(encoding="utf-8"))
                self.assertIn("Layout test", output.read_text(encoding="utf-8"))
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][:2], ("shared-profile", TARGET["regionId"]))
                self.assertIn("GetLogsV2", calls[0][2])

    def test_publish_without_confirm_only_reads_dashboard(self):
        for label, root, skills in self.forms():
            scripts = self.query_scripts(skills)
            publisher = skills / "sls-dashboard-builder" / "scripts" / "publish_dashboard.py"
            for missing in (False, True):
                with self.subTest(layout=label, missing=missing), import_script(publisher, scripts, self.fake_home) as module:
                    self.assertEqual(Path(sys.modules["util.aliyun"].__file__), scripts / "util" / "aliyun.py")
                    calls = []

                    def fake_cli(profile, region, argv):
                        calls.append(argv)
                        return (None, "DashboardNotExist") if missing else ({"dashboardName": "layout-test"}, "")

                    dashboard = self.dashboard_fixture()
                    stdout = io.StringIO()
                    with mock.patch.object(module, "require_profile", return_value="shared-profile"), \
                            mock.patch.object(module, "load_target", return_value=TARGET), \
                            mock.patch.object(module, "aliyun", side_effect=fake_cli), \
                            mock.patch.object(sys, "argv", [str(publisher), "--dashboard", str(dashboard)]), \
                            working_directory(self.business), contextlib.redirect_stdout(stdout):
                        self.assertEqual(module.main(), 0)
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(calls[0][:2], ["sls", "GetDashboard"])
                    self.assertIn("dry_run=true", stdout.getvalue())
                    self.assertNotIn("published=true", stdout.getvalue())
                    self.assertIn("action=" + ("create" if missing else "update"), stdout.getvalue())

    def test_collector_import_and_argument_help_are_offline(self):
        for label, root, skills in self.forms():
            scripts = self.query_scripts(skills)
            collector = skills / "agentloop-collector-setup" / "scripts" / "install.py"
            with self.subTest(layout=label), import_script(collector, scripts, self.fake_home) as module:
                self.assertEqual(Path(sys.modules["util.aliyun"].__file__), scripts / "util" / "aliyun.py")
                with mock.patch.object(module, "require_profile", side_effect=AssertionError("No authorization")), \
                        mock.patch.object(module, "get_space", side_effect=AssertionError("No cloud")):
                    self.assertEqual(module.parse_args(["--agent-space", "demo-space", "--region", "cn-test", "--user-id-source", "email"]),
                                     ("demo-space", "cn-test", "email"))
                    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaises(SystemExit) as status:
                            module.parse_args(["--help"])
                    self.assertIn(status.exception.code, (0, 2))

    def test_markdown_relative_links_survive_both_copied_shapes(self):
        for label, root, skills in self.forms():
            for path in skills.rglob("*.md"):
                for dest in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
                    parts = urlsplit(dest)
                    if parts.scheme or dest.startswith("#") or "<" in dest or ">" in dest:
                        continue
                    relative = unquote(parts.path)
                    if not relative:
                        continue
                    with self.subTest(layout=label, document=str(path.relative_to(skills)), link=dest):
                        self.assertTrue((path.parent / relative).exists(), "Broken relative Markdown link")

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell runtime is not installed")
    def test_powershell_compat_preserves_script_arguments_without_native_hop(self):
        # Execute PS7 script-to-script forwarding, not a Windows 5.1 process.
        child = self.query_scripts(self.plugin / "skills") / "run.ps1"
        child.write_text("""$result = @{ argv = @($args); cwd = (Get-Location).ProviderPath }
Write-Output ('PS_CHILD=' + ($result | ConvertTo-Json -Compress -Depth 5))
[Console]::Error.WriteLine('ps-child-stderr')
exit 7
""", encoding="utf-8")
        args = ["audit", "--query", '* | SELECT "user.id", \'a b\' AS "label"',
                "--dashboard", str(self.business / "a report with spaces.json"),
                "--from", "100", "--to", "200"]
        result = subprocess.run([shutil.which("pwsh"), "-NoLogo", "-NoProfile", "-NonInteractive",
                                 "-File", str(self.plugin / "scripts" / "run.ps1"), *args],
                                cwd=self.business, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(result.returncode, 7, result.stderr)
        lines = [line.removeprefix("PS_CHILD=") for line in result.stdout.splitlines()
                 if line.startswith("PS_CHILD=")]
        self.assertEqual(len(lines), 1, result.stdout)
        actual = json.loads(lines[0])
        self.assertEqual(actual["argv"], args)
        self.assertEqual(Path(actual["cwd"]).resolve(), self.business)
        self.assertIn("ps-child-stderr", result.stderr)
        self.assertEqual(list(self.fake_home.iterdir()), [])

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell parser is not installed")
    def test_powershell_parser_and_read_only_auth_root_selection(self):
        # PowerShell 7 parsing/library checks do not claim Windows 5.1 execution.
        binary = shutil.which("pwsh")
        for label, root, skills in self.forms():
            library = self.query_scripts(skills) / "lib" / "config-record.ps1"
            literal = lambda value: "'" + str(value).replace("'", "''") + "'"
            program = """$ErrorActionPreference = 'Stop'
$all = Get-ChildItem -LiteralPath """ + literal(root) + """ -Recurse -Filter '*.ps1'
foreach ($file in $all) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ('PowerShell syntax error: ' + $file.Name) }
}
. """ + literal(library) + """
@{ root = $script:PLUGIN_ROOT; config = $script:ALIYUN_CONFIG } | ConvertTo-Json -Compress
"""
            env = dict(os.environ)
            env["USERPROFILE"] = str(self.fake_home)
            with self.subTest(layout=label):
                result = subprocess.run([binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
                                        cwd=self.business, env=env, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                actual = json.loads(result.stdout)
                expected = root if label == "plugin" else skills / "agentloop-audit-query"
                self.assertEqual(Path(actual["root"]).resolve(), expected.resolve())
                self.assertEqual(Path(actual["config"]).resolve(), expected.resolve() / "aliyun" / "config.json")
                self.assertFalse((expected / "aliyun").exists())
                self.assertEqual(list(self.fake_home.iterdir()), [])

    def test_powershell_routes_and_new_comment_ascii_static_only(self):
        for label, root, skills in self.forms():
            router = self.query_scripts(skills) / "run.ps1"
            with self.subTest(layout=label):
                text = router.read_text(encoding="utf-8-sig")
                for command, (skill, filename) in CHILDREN.items():
                    expected = filename.replace("_", "-").replace(".py", ".ps1")
                    self.assertIn(command, text)
                    self.assertIn(expected, text)
                    self.assertTrue((skills / skill / "scripts" / expected).is_file())
                self.assertIn("sls-dashboard-builder", text)
                self.assertIn("agentloop-collector-setup", text)
                self.assertIn("@", text)
        compat = (self.plugin / "scripts" / "run.ps1").read_text(encoding="utf-8-sig")
        self.assertIn("agentloop-audit-query", compat)
        self.assertIn("run.ps1", compat)
        self.assertIn("@args", compat)
        original_comments = Counter()
        for relative in tracked_paths():
            if relative.suffix.lower() != ".ps1":
                continue
            old = subprocess.run(["git", "show", "HEAD:" + relative.as_posix()], cwd=REPO,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if old.returncode == 0:
                original_comments.update(line.strip() for line in old.stdout.decode("utf-8-sig").splitlines()
                                         if line.lstrip().startswith("#"))
        for path in self.plugin.rglob("*.ps1"):
            comments = Counter(line.strip() for line in path.read_text(encoding="utf-8-sig").splitlines()
                               if line.lstrip().startswith("#"))
            for line in (comments - original_comments):
                with self.subTest(script=str(path.relative_to(self.plugin)), comment=line):
                    self.assertTrue(line.isascii(), "New PowerShell comments must be ASCII")


if __name__ == "__main__":
    unittest.main()
