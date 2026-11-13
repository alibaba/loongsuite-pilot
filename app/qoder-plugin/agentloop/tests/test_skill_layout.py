"""Offline contracts for plugin and adjacent, independently copied Skills.

Run with ``python3 -m unittest discover -s app/qoder-plugin/agentloop/tests -v``.
All executable fixtures, fake CLI calls and generated HTML stay in temporary
paths containing spaces. No real CLI, login, user credential file or cloud is used.
All credential-shaped configuration fixtures are synthetic test sentinels.
PowerShell checks use local pwsh when available and do not claim Windows 5.1 runtime.
"""
import contextlib
from collections import Counter
from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import runpy
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
    "auth": ("agentloop-collector-setup", "ensure_oauth.py"),
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
def import_script(path, shared_scripts, fake_home):
    """Import one copied module without consulting any real home configuration."""
    prefixes = ("util", "ensure_oauth")
    saved_modules = {key: value for key, value in sys.modules.items()
                     if any(key == prefix or key.startswith(prefix + ".")
                            for prefix in prefixes)}
    for key in saved_modules:
        del sys.modules[key]
    old_path = list(sys.path)
    sys.path.insert(0, str(shared_scripts))
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

    def setup_scripts(self, skills):
        return skills / "agentloop-collector-setup" / "scripts"

    def routers(self):
        plugin_skills = self.plugin / "skills"
        return [("plugin-compat", self.plugin / "scripts" / "run.py", plugin_skills),
                ("plugin-setup", self.setup_scripts(plugin_skills) / "run.py", plugin_skills),
                ("plugin-query-compat", self.query_scripts(plugin_skills) / "run.py", plugin_skills),
                ("standalone-setup", self.setup_scripts(self.standalone) / "run.py", self.standalone),
                ("standalone-query-compat", self.query_scripts(self.standalone) / "run.py", self.standalone)]

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
            scripts = self.setup_scripts(skills)
            with self.subTest(layout=label), import_script(scripts / "util" / "aliyun.py", scripts, self.fake_home) as module:
                expected_home = root / "aliyun" if label == "plugin" else skills / "agentloop-collector-setup" / "aliyun"
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

    def synthetic_profiles(self):
        return {"current": "alpha", "language": "en", "profiles": [
            {"name": "alpha", "mode": "OAuth", "oauth_site_type": "CN",
             "oauth_refresh_token": "SYNTHETIC_ALPHA_TOKEN"},
            {"name": "beta", "mode": "AK", "access_key_id": "SYNTHETIC_BETA_ID",
             "access_key_secret": "SYNTHETIC_BETA_SECRET"},
            {"name": "unfinished", "mode": "OAuth", "oauth_site_type": "INTL"},
            {"name": "Alpha", "mode": "AK", "access_key_id": "SYNTHETIC_CASE_ID",
             "access_key_secret": "SYNTHETIC_CASE_SECRET"},
        ]}

    @contextlib.contextmanager
    def synthetic_profile_state(self, module):
        # All credential-shaped values are explicit synthetic test sentinels.
        path = self.business / "synthetic_profiles.json"
        path.write_text(json.dumps(self.synthetic_profiles()), encoding="utf-8")
        state = {"profile": "alpha", **TARGET, "updatedAt": "previous-window", "note": "keep"}
        records = sys.modules["util.config_record"]
        transport = sys.modules["util.aliyun"]

        def read():
            return deepcopy(state)

        def write(value):
            state.clear()
            state.update(deepcopy(value))

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(records, "read_record", side_effect=read))
            stack.enter_context(mock.patch.object(records, "write_record", side_effect=write))
            stack.enter_context(mock.patch.object(transport, "aliyun_config_path", return_value=str(path)))
            if hasattr(module, "read_record"):
                stack.enter_context(mock.patch.object(module, "read_record", side_effect=read))
            if hasattr(module, "aliyun_config_path"):
                stack.enter_context(mock.patch.object(module, "aliyun_config_path", return_value=str(path)))
            yield path, state

    def test_profile_list_is_sanitized_read_only_and_offline(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            auth = scripts / "ensure_oauth.py"
            with self.subTest(layout=label), import_script(auth, scripts, self.fake_home) as module:
                with self.synthetic_profile_state(module) as (path, state):
                    state["profile"] = "alpha"
                    before, before_state = path.read_bytes(), deepcopy(state)
                    transport, records = sys.modules["util.aliyun"], sys.modules["util.config_record"]
                    stdout = io.StringIO()
                    with mock.patch.object(transport, "aliyun_bin", side_effect=AssertionError("No CLI discovery/download")), \
                            mock.patch.object(records, "save_profile", side_effect=AssertionError("No selection changes")), \
                            mock.patch.object(records, "write_private_text", side_effect=AssertionError("No config writes")), \
                            mock.patch("subprocess.run", side_effect=AssertionError("No CLI/cloud calls")), \
                            mock.patch.object(sys, "argv", [str(auth), "--list"]), \
                            contextlib.redirect_stdout(stdout):
                        runpy.run_path(str(auth), run_name="__main__")
                    text = stdout.getvalue()
                    actual = json.loads(text)
                    self.assertEqual(set(actual), {"selected_profile", "profiles"})
                    self.assertEqual(actual["selected_profile"], "alpha")
                    profiles = {row["name"]: row for row in actual["profiles"]}
                    self.assertEqual(set(profiles), {"alpha", "Alpha", "beta", "unfinished"})
                    for row in profiles.values():
                        self.assertEqual(set(row), {"name", "mode", "site_type", "configured", "selected"})
                    self.assertEqual(profiles["alpha"]["site_type"], "CN")
                    self.assertTrue(profiles["alpha"]["configured"])
                    self.assertTrue(profiles["beta"]["configured"])
                    self.assertFalse(profiles["unfinished"]["configured"])
                    self.assertEqual([name for name, row in profiles.items() if row["selected"]], ["alpha"])
                    for forbidden in ("SYNTHETIC_", "access_key", "refresh_token", "config_path"):
                        self.assertNotIn(forbidden, text)
                    self.assertEqual(path.read_bytes(), before)
                    self.assertEqual(state, before_state)

    def test_profile_switch_clears_target_but_same_profile_preserves_it(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            with self.subTest(layout=label), import_script(scripts / "util" / "config_record.py", scripts, self.fake_home) as module:
                # Use this imported record module directly, with memory-backed IO.
                state = {"profile": "alpha", **TARGET, "updatedAt": "old", "note": "keep"}
                def write(value):
                    state.clear()
                    state.update(deepcopy(value))
                with mock.patch.object(module, "read_record", side_effect=lambda: deepcopy(state)), \
                        mock.patch.object(module, "write_record", side_effect=write):
                    unchanged = deepcopy(state)
                    module.save_profile("alpha")
                    self.assertEqual(state, unchanged)
                    module.save_profile("Alpha")
                    self.assertEqual(state, {"profile": "Alpha", "note": "keep"})
                    state.update(TARGET, updatedAt="case-target")
                    module.save_profile("beta")
                    self.assertEqual(state, {"profile": "beta", "note": "keep"})

    def test_create_and_reuse_profile_preserves_other_profiles(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            with self.subTest(layout=label), import_script(scripts / "ensure_oauth.py", scripts, self.fake_home) as module:
                with self.synthetic_profile_state(module) as (path, state):
                    original = self.synthetic_profiles()
                    calls = []
                    def fake_configure(argv, **kwargs):
                        calls.append(argv)
                        self.assertEqual(argv[1:4], ["configure", "--mode", "OAuth"])
                        seeded = json.loads(path.read_text(encoding="utf-8"))
                        profile = next(p for p in seeded["profiles"] if p["name"] == "new-account")
                        self.assertEqual(profile["oauth_site_type"], "INTL")
                        profile["oauth_refresh_token"] = "SYNTHETIC_NEW_TOKEN"
                        path.write_text(json.dumps(seeded), encoding="utf-8")
                        return subprocess.CompletedProcess(argv, 0)
                    with mock.patch.object(module, "aliyun_bin", return_value="fake-aliyun"), \
                            mock.patch.object(module.subprocess, "run", side_effect=fake_configure), \
                            contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(module.run(["--profile", "new-account", "--oauth-site-type", "INTL"]), "new-account")
                    after = json.loads(path.read_text(encoding="utf-8"))
                    self.assertEqual(after["profiles"][:len(original["profiles"])], original["profiles"])
                    self.assertEqual(after["current"], original["current"])
                    self.assertEqual(after["language"], original["language"])
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(state, {"profile": "new-account", "note": "keep"})
                    state.update(TARGET, updatedAt="restored-target")
                    before_reuse, expected_state = path.read_bytes(), deepcopy(state)
                    with mock.patch.object(module, "aliyun_bin", return_value="fake-aliyun"), \
                            mock.patch.object(module, "configure_oauth", side_effect=AssertionError("Do not authorize a ready profile")):
                        self.assertEqual(module.run(["--profile", "new-account", "--oauth-site-type", "INTL"]), "new-account")
                    self.assertEqual(path.read_bytes(), before_reuse)
                    self.assertEqual(state, expected_state)

    def test_failed_authorization_restores_profiles_and_keeps_selection(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            with self.subTest(layout=label), import_script(scripts / "ensure_oauth.py", scripts, self.fake_home) as module:
                with self.synthetic_profile_state(module) as (path, state):
                    before, expected_state = path.read_bytes(), deepcopy(state)
                    with mock.patch.object(module, "aliyun_bin", return_value="fake-aliyun"), \
                            mock.patch.object(module, "aliyun_command_hint", return_value="fake-aliyun"), \
                            mock.patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 9)), \
                            mock.patch.object(module, "save_profile", wraps=module.save_profile) as save, \
                            contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as failed:
                            module.run(["--profile", "new-account", "--oauth-site-type", "INTL"])
                    self.assertEqual(failed.exception.code, 9)
                    save.assert_not_called()
                    self.assertEqual(path.read_bytes(), before)
                    self.assertEqual(state, expected_state)

    def test_explicit_agentspace_switch_and_restore_are_metadata_only(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            query = self.query_scripts(skills) / "query.py"
            with self.subTest(layout=label), import_script(query, scripts, self.fake_home) as module:
                with self.synthetic_profile_state(module) as (path, state):
                    def space(profile, name, region):
                        self.assertEqual(profile, "alpha")
                        if name == "second-space":
                            self.assertEqual(region, "cn-second")
                            return {"agentSpace": name, "regionId": region, "slsProject": "second-project"}
                        self.assertEqual((name, region), (TARGET["agentSpace"], TARGET["regionId"]))
                        return deepcopy(TARGET)
                    with mock.patch.object(module, "require_profile", return_value="alpha"), \
                            mock.patch.object(module, "get_space", side_effect=space) as get_space, \
                            mock.patch.object(module, "get_logs", side_effect=AssertionError("No GetLogs metadata binding")), \
                            mock.patch.object(module, "append_history", side_effect=AssertionError("No query history for metadata")), \
                            contextlib.redirect_stdout(io.StringIO()):
                        module.run(["--agent-space", "second-space", "--region", "cn-second", "--list"])
                        self.assertEqual((state["profile"], state["agentSpace"], state["slsProject"]),
                                         ("alpha", "second-space", "second-project"))
                        module.run(["--agent-space", TARGET["agentSpace"], "--region", TARGET["regionId"], "--list"])
                        self.assertEqual({k: state[k] for k in TARGET}, TARGET)
                        module.run(["--logstore", "incident-event", "--list"])
                        self.assertEqual(state["slsLogstore"], "incident-event")
                        module.run(["--logstore", TARGET["slsLogstore"], "--list"])
                    self.assertEqual(get_space.call_count, 2)
                    self.assertEqual({k: state[k] for k in TARGET}, TARGET)
                    self.assertEqual(state["profile"], "alpha")

    def target_binding_cases(self):
        return [
            ("new-project-complete", ["--project", "second-project", "--region", "cn-second", "--logstore", "incident-event"],
             {"agentSpace": "", "regionId": "cn-second", "slsProject": "second-project", "slsLogstore": "incident-event"}, (), False),
            ("same-project-rebind", ["--project", TARGET["slsProject"]], {**TARGET, "agentSpace": ""}, (), False),
            ("same-project-same-region", ["--project", TARGET["slsProject"], "--region", TARGET["regionId"]], {**TARGET, "agentSpace": ""}, (), False),
            ("same-region-partial", ["--region", TARGET["regionId"]], TARGET, (), False),
            ("logstore-only", ["--logstore", "incident-event"], {**TARGET, "slsLogstore": "incident-event"}, (), False),
            ("space-with-logstore", ["--agent-space", "second-space", "--region", "cn-second", "--logstore", "incident-event"],
             {"agentSpace": "second-space", "regionId": "cn-second", "slsProject": "second-project", "slsLogstore": "incident-event"}, (), True),
            ("new-project-missing-both", ["--project", "second-project"], None, ("region", "logstore"), False),
            ("new-project-missing-region", ["--project", "second-project", "--logstore", "incident-event"], None, ("region",), False),
            ("new-project-missing-logstore", ["--project", "second-project", "--region", "cn-second"], None, ("logstore",), False),
            ("new-region-missing-both", ["--region", "cn-second"], None, ("project", "logstore"), False),
            ("new-region-missing-project", ["--region", "cn-second", "--logstore", "incident-event"], None, ("project",), False),
            ("same-project-new-region-needs-logstore", ["--project", TARGET["slsProject"], "--region", "cn-second"], None, ("logstore",), False),
            ("space-needs-explicit-region", ["--agent-space", "second-space", "--logstore", "incident-event"], None, ("region",), False),
            ("space-project-conflict", ["--agent-space", "second-space", "--project", TARGET["slsProject"], "--region", "cn-second", "--logstore", "incident-event"], None, ("project", "agent"), False),
        ]

    def test_query_target_modes_do_not_inherit_cross_project_or_region_state(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            with import_script(self.query_scripts(skills) / "query.py", scripts, self.fake_home) as module:
                for name, args, expected, missing, use_space in self.target_binding_cases():
                    with self.subTest(layout=label, case=name), self.synthetic_profile_state(module) as (path, state):
                        before = deepcopy(state)
                        records = sys.modules["util.config_record"]
                        stdout, stderr = io.StringIO(), io.StringIO()
                        with mock.patch.object(module, "require_profile", return_value="alpha"), \
                                mock.patch.object(module, "get_space", return_value={"agentSpace": "second-space", "regionId": "cn-second", "slsProject": "second-project"}) as space, \
                                mock.patch.object(module, "get_logs", side_effect=AssertionError("No GetLogs for binding")), \
                                mock.patch.object(module, "append_history", side_effect=AssertionError("No history for binding")), \
                                mock.patch.object(records, "write_record", wraps=records.write_record) as writes, \
                                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                            if expected is None:
                                with self.assertRaises(SystemExit) as failure:
                                    module.run([*args, "--list"])
                                self.assertEqual(failure.exception.code, 1)
                            else:
                                module.run([*args, "--list"])
                        if expected is None:
                            self.assertEqual(state, before)
                            writes.assert_not_called()
                            for field in missing:
                                self.assertIn(field, stderr.getvalue().lower())
                        else:
                            self.assertEqual({k: state[k] for k in TARGET}, expected)
                            self.assertEqual(state["profile"], "alpha")
                            self.assertEqual(writes.call_count, 1)
                            self.assertEqual(json.loads(stdout.getvalue())["context"], expected)
                        if use_space:
                            space.assert_called_once_with("alpha", "second-space", "cn-second")
                        else:
                            space.assert_not_called()

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell runtime is not installed")
    def test_powershell_query_target_modes_with_fake_metadata_and_record_io(self):
        initial = {"profile": "alpha", **TARGET, "updatedAt": "original-window"}
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            with (scripts / "lib" / "config-record.ps1").open("a", encoding="utf-8") as f:
                f.write("""
function Require-Profile { return 'alpha' }
function Read-AuditRecord {
    if (Test-Path -LiteralPath $env:SKILL_LAYOUT_STATE) { $json = Get-Content -Raw -LiteralPath $env:SKILL_LAYOUT_STATE }
    else { $json = $env:SKILL_LAYOUT_INITIAL_STATE }
    $object = $json | ConvertFrom-Json
    $data = @{}
    foreach ($property in $object.PSObject.Properties) { $data[$property.Name] = $property.Value }
    return $data
}
function Write-AuditRecord($Data) {
    ConvertTo-Json -InputObject $Data -Compress | Set-Content -LiteralPath $env:SKILL_LAYOUT_STATE -Encoding UTF8
}
function Add-HistoryRow { throw 'No history for binding' }
function Write-Utf8NoBom { throw 'No production config writes' }
""")
            with (scripts / "lib" / "aliyun.ps1").open("a", encoding="utf-8") as f:
                f.write("""
function Get-AgentSpace([string]$Profile, [string]$AgentSpace, [string]$Region) {
    @{ profile=$Profile; agentSpace=$AgentSpace; region=$Region } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:SKILL_LAYOUT_SPACE_TRACE -Encoding UTF8
    return @{ agentSpace='second-space'; regionId='cn-second'; slsProject='second-project' }
}
function Get-PilotLogs { throw 'No GetLogs for binding' }
function Invoke-AliyunApi { throw 'No real cloud calls' }
""")
            for name, args, expected, missing, use_space in self.target_binding_cases():
                state_path = self.business / (label + '-' + name + '-state.json')
                trace = self.business / (label + '-' + name + '-space.jsonl')
                env = dict(os.environ, USERPROFILE=str(self.fake_home), SKILL_LAYOUT_STATE=str(state_path),
                           SKILL_LAYOUT_INITIAL_STATE=json.dumps(initial), SKILL_LAYOUT_SPACE_TRACE=str(trace))
                with self.subTest(layout=label, case=name):
                    result = subprocess.run([shutil.which("pwsh"), "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                                             str(self.query_scripts(skills) / "query.ps1"), *args, "--list"],
                                            cwd=self.business, env=env, text=True, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, timeout=20)
                    if expected is None:
                        self.assertEqual(result.returncode, 1, result.stderr)
                        self.assertFalse(state_path.exists(), "Rejected target must not write a record")
                        for field in missing:
                            self.assertIn(field, result.stderr.lower())
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        actual = json.loads(state_path.read_text(encoding="utf-8-sig"))
                        self.assertEqual({k: actual[k] for k in TARGET}, expected)
                        self.assertEqual(actual["profile"], "alpha")
                        self.assertEqual(json.loads(result.stdout)["context"], expected)
                    calls = [json.loads(line) for line in trace.read_text(encoding="utf-8-sig").splitlines()] if trace.exists() else []
                    self.assertEqual(calls, [{"profile": "alpha", "agentSpace": "second-space", "region": "cn-second"}] if use_space else [])

    def test_list_spaces_with_existing_target_is_metadata_only(self):
        expected = {"spaces": [{"agentSpace": "first", "regionId": "cn-one"},
                               {"agentSpace": "second", "regionId": "cn-two"}]}
        source = [{**row, "slsProject": "not-output"} for row in expected["spaces"]]
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            with self.subTest(layout=label), import_script(self.query_scripts(skills) / "query.py", scripts, self.fake_home) as module:
                with self.synthetic_profile_state(module) as (path, state):
                    before, before_state = path.read_bytes(), deepcopy(state)
                    for region in ("", "cn-one"):
                        stdout, stderr = io.StringIO(), io.StringIO()
                        args = ["--list-spaces"] + (["--region", region] if region else [])
                        with mock.patch.object(module, "require_profile", return_value="alpha"), \
                                mock.patch.object(module, "list_spaces", return_value=(source, ["region unavailable"])) as listing, \
                                mock.patch.object(module, "get_space", side_effect=AssertionError("No implicit selection")), \
                                mock.patch.object(module, "get_logs", side_effect=AssertionError("No GetLogs")), \
                                mock.patch.object(module, "save_target", side_effect=AssertionError("No target writes")), \
                                mock.patch.object(module, "append_history", side_effect=AssertionError("No history writes")), \
                                mock.patch.object(module, "query_window", side_effect=AssertionError("No query time needed")), \
                                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                            module.run(args)
                        listing.assert_called_once_with("alpha", region)
                        self.assertEqual(json.loads(stdout.getvalue()), expected)
                        self.assertIn("region unavailable", stderr.getvalue())
                        self.assertEqual(state, before_state)
                        self.assertEqual(path.read_bytes(), before)

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell runtime is not installed")
    def test_powershell_list_spaces_does_not_change_existing_target_or_query_logs(self):
        expected = {"spaces": [{"agentSpace": "first", "regionId": "cn-one"},
                               {"agentSpace": "second", "regionId": "cn-two"}]}
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            record = self.fake_home / ".loongsuite-pilot" / "audit" / "config-record.json"
            record.parent.mkdir(parents=True, exist_ok=True)
            record.write_text(json.dumps({"profile": "alpha", **TARGET}), encoding="utf-8")
            before = record.read_bytes()
            with (scripts / "lib" / "config-record.ps1").open("a", encoding="utf-8") as f:
                f.write("""
function Require-Profile { return 'alpha' }
function Save-AuditTarget { throw 'No target writes' }
function Save-AuditProfile { throw 'No profile writes' }
function Add-HistoryRow { throw 'No history writes' }
function Write-Utf8NoBom { throw 'No config writes' }
""")
            with (scripts / "lib" / "aliyun.ps1").open("a", encoding="utf-8") as f:
                f.write("""
function Get-AgentSpaces([string]$Profile, [string]$Region) {
    if ($Profile -cne 'alpha' -or $Region -cne $env:SKILL_LAYOUT_EXPECTED_REGION) { throw 'Wrong metadata scope' }
    $script:AgentSpaceListErrors = @('region unavailable')
    return @(@{agentSpace='first'; regionId='cn-one'; slsProject='not-output'}, @{agentSpace='second'; regionId='cn-two'; slsProject='not-output'})
}
function Get-AgentSpace { throw 'No implicit selection' }
function Get-PilotLogs { throw 'No GetLogs' }
function Invoke-AliyunApi { throw 'No real cloud calls' }
""")
            query = self.query_scripts(skills) / "query.ps1"
            for region in ("", "cn-one"):
                env = dict(os.environ, USERPROFILE=str(self.fake_home), SKILL_LAYOUT_EXPECTED_REGION=region)
                args = ["--list-spaces"] + (["--region", region] if region else [])
                with self.subTest(layout=label, region=region):
                    result = subprocess.run([shutil.which("pwsh"), "-NoLogo", "-NoProfile", "-NonInteractive",
                                             "-File", str(query), *args], cwd=self.business, env=env,
                                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), expected)
                    self.assertIn("region unavailable", result.stderr)
                    self.assertEqual(record.read_bytes(), before)
                    self.assertEqual(list(record.parent.iterdir()), [record])

    def test_legacy_query_auth_root_uses_only_metadata_until_setup_is_configured(self):
        skills = self.standalone
        scripts = self.setup_scripts(skills)
        legacy = self.query_scripts(skills).parent / "aliyun" / "config.json"
        configured = scripts.parent / "aliyun" / "config.json"
        legacy.parent.mkdir()
        legacy.touch()
        real_open = open
        def forbid_config_read(file, *args, **kwargs):
            if Path(file) in (legacy, configured):
                raise AssertionError("Auth-root selection must not read config contents")
            return real_open(file, *args, **kwargs)
        for expected in (legacy, configured):
            if expected == configured:
                configured.parent.mkdir()
                configured.touch()
            with self.subTest(selected=str(expected)), mock.patch("builtins.open", side_effect=forbid_config_read), \
                    import_script(scripts / "util" / "aliyun.py", scripts, self.fake_home) as module:
                self.assertEqual(Path(module.aliyun_config_path()), expected)

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

    def test_builder_renders_html_with_shared_setup_auth(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
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
            scripts = self.setup_scripts(skills)
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
            scripts = self.setup_scripts(skills)
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
        child = self.setup_scripts(self.plugin / "skills") / "run.ps1"
        child.write_text("""$result = @{ argv = @($args); cwd = (Get-Location).ProviderPath }
Write-Output ('PS_CHILD=' + ($result | ConvertTo-Json -Compress -Depth 5))
[Console]::Error.WriteLine('ps-child-stderr')
exit 7
""", encoding="utf-8")
        args = ["audit", "--query", '* | SELECT "user.id", \'a b\' AS "label"',
                "--dashboard", str(self.business / "a report with spaces.json"),
                "--from", "100", "--to", "200"]
        wrappers = [self.plugin / "scripts" / "run.ps1",
                    self.query_scripts(self.plugin / "skills") / "run.ps1"]
        for wrapper in wrappers:
            with self.subTest(wrapper=str(wrapper.relative_to(self.plugin))):
                result = subprocess.run([shutil.which("pwsh"), "-NoLogo", "-NoProfile", "-NonInteractive",
                                         "-File", str(wrapper), *args],
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

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell runtime is not installed")
    def test_powershell_profile_switch_uses_memory_io_and_case_sensitive_names(self):
        for label, root, skills in self.forms():
            library = self.setup_scripts(skills) / "lib" / "config-record.ps1"
            quoted = "'" + str(library).replace("'", "''") + "'"
            program = """$ErrorActionPreference = 'Stop'
. """ + quoted + """
$script:LayoutState = @{ profile='alpha'; agentSpace='demo-space'; regionId='cn-test'; slsProject='demo-project'; slsLogstore='agent-event'; updatedAt='old' }
function Read-AuditRecord { return $script:LayoutState.Clone() }
function Write-AuditRecord($Data) { $script:LayoutState = $Data.Clone() }
Save-AuditProfile 'alpha'
$same = $script:LayoutState.Clone()
Save-AuditProfile 'Alpha'
@{ same=$same; switched=$script:LayoutState } | ConvertTo-Json -Compress -Depth 5
"""
            env = dict(os.environ, USERPROFILE=str(self.fake_home))
            with self.subTest(layout=label):
                result = subprocess.run([shutil.which("pwsh"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
                                        cwd=self.business, env=env, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                actual = json.loads(result.stdout)
                self.assertEqual(actual["same"], {"profile": "alpha", **TARGET, "updatedAt": "old"})
                self.assertEqual(actual["switched"], {"profile": "Alpha"})
                self.assertEqual(list(self.fake_home.iterdir()), [])

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell runtime is not installed")
    def test_powershell_profile_list_is_sanitized_and_case_sensitive(self):
        for label, root, skills in self.forms():
            scripts = self.setup_scripts(skills)
            auth = scripts / "ensure-oauth.ps1"
            home = root / "aliyun" if label == "plugin" else scripts.parent / "aliyun"
            home.mkdir()
            config = home / "config.json"
            config.write_text(json.dumps(self.synthetic_profiles()), encoding="utf-8")
            record = self.fake_home / ".loongsuite-pilot" / "audit" / "config-record.json"
            record.parent.mkdir(parents=True, exist_ok=True)
            record.write_text(json.dumps({"profile": "alpha", **TARGET}), encoding="utf-8")
            before = (config.read_bytes(), record.read_bytes())
            quoted = "'" + str(auth).replace("'", "''") + "'"
            program = """function global:Invoke-WebRequest { throw 'Network forbidden' }
function global:Start-Process { throw 'Browser forbidden' }
& """ + quoted + """ --list
exit $LASTEXITCODE
"""
            env = dict(os.environ, USERPROFILE=str(self.fake_home))
            with self.subTest(layout=label):
                result = subprocess.run([shutil.which("pwsh"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
                                        cwd=self.business, env=env, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                actual = json.loads(result.stdout)
                self.assertEqual(set(actual), {"selected_profile", "profiles"})
                self.assertEqual(actual["selected_profile"], "alpha")
                self.assertEqual([row["name"] for row in actual["profiles"] if row["selected"]], ["alpha"])
                for row in actual["profiles"]:
                    self.assertEqual(set(row), {"name", "mode", "site_type", "configured", "selected"})
                self.assertNotIn("SYNTHETIC_", result.stdout)
                self.assertNotIn("refresh_token", result.stdout)
                self.assertNotIn("access_key", result.stdout)
                self.assertEqual((config.read_bytes(), record.read_bytes()), before)
                self.assertEqual(list(home.iterdir()), [config])

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell parser is not installed")
    def test_powershell_parser_and_read_only_auth_root_selection(self):
        # PowerShell 7 parsing/library checks do not claim Windows 5.1 execution.
        binary = shutil.which("pwsh")
        for label, root, skills in self.forms():
            library = self.setup_scripts(skills) / "lib" / "config-record.ps1"
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
                expected = root if label == "plugin" else skills / "agentloop-collector-setup"
                self.assertEqual(Path(actual["root"]).resolve(), expected.resolve())
                self.assertEqual(Path(actual["config"]).resolve(), expected.resolve() / "aliyun" / "config.json")
                self.assertFalse((expected / "aliyun").exists())
                self.assertEqual(list(self.fake_home.iterdir()), [])

    def test_powershell_routes_and_new_comment_ascii_static_only(self):
        for label, root, skills in self.forms():
            router = self.setup_scripts(skills) / "run.ps1"
            with self.subTest(layout=label):
                text = router.read_text(encoding="utf-8-sig")
                for command, (skill, filename) in CHILDREN.items():
                    expected = filename.replace("_", "-").replace(".py", ".ps1")
                    self.assertIn(command, text)
                    self.assertIn(expected, text)
                    self.assertTrue((skills / skill / "scripts" / expected).is_file())
                self.assertIn("sls-dashboard-builder", text)
                self.assertIn("agentloop-audit-query", text)
                self.assertIn("@", text)
                query_compat = (self.query_scripts(skills) / "run.ps1").read_text(encoding="utf-8-sig")
                self.assertIn("agentloop-collector-setup", query_compat)
                self.assertIn("@args", query_compat)
                self.assertNotIn("powershell.exe", query_compat.lower())
        compat = (self.plugin / "scripts" / "run.ps1").read_text(encoding="utf-8-sig")
        self.assertIn("agentloop-collector-setup", compat)
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
