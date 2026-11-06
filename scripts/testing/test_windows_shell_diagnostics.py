import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec=importlib.util.spec_from_file_location("pilot_diagnostic",str(Path(__file__).with_name("windows-shell-diagnostics.py")))
diagnostic=importlib.util.module_from_spec(spec);spec.loader.exec_module(diagnostic)

class WindowsDiagnosticContracts(unittest.TestCase):
    def test_original_payloads_remain_exact_and_write_output_is_not_replaced(self):
        self.assertEqual([x[0] for x in diagnostic.PAYLOADS],["console","capture-cmdlet","literal-pipeline","cmdlet-pipeline"])
        self.assertIn("$v=Write-Output",diagnostic.PAYLOADS[1][1])
        self.assertEqual(diagnostic.PAYLOADS[3][1],"Write-Output 'PILOT_SHELL_SENTINEL'")
        self.assertNotIn("LanguageMode",diagnostic.script(diagnostic.PAYLOADS[3][1]))

    def test_isolated_variants_never_inherit_user_runtime_paths_or_ci_secrets(self):
        env={"SystemRoot":"C:\\Windows","SystemDrive":"C:","ProgramData":"C:\\ProgramData","PATH":"SECRET_NODE_PATH","GH_TOKEN":"SYNTHETIC_SECRET","PSModulePath":"USER_MODULES"}
        with mock.patch.dict(os.environ,env,clear=True):
            for mode in ["isolated","builtin-modules","cache-disabled","minimal-os-path","system-drive-data"]:
                result=diagnostic.environment(Path("synthetic-home"),Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),mode,Path("marker"))
                self.assertNotIn("GH_TOKEN",result)
                self.assertNotIn("SECRET_NODE_PATH",result["PATH"])
                self.assertNotEqual(result.get("PSModulePath"),"USER_MODULES")
                self.assertEqual(result["HOME"],"synthetic-home")
            self.assertEqual(diagnostic.environment(Path("h"),Path("shell.exe"),"cache-disabled",Path("m"))["PSModuleAnalysisCachePath"],"NUL")

    def test_unchanged_five_second_budget_still_kills_and_fails_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            child=mock.MagicMock();child.returncode=-9
            child.communicate.side_effect=[subprocess.TimeoutExpired("fixed-shell",5),(b"",b"")]
            with mock.patch.object(subprocess,"CREATE_NO_WINDOW",0,create=True),mock.patch.object(subprocess,"Popen",return_value=child):
                result=diagnostic.run_case(Path("powershell.exe"),"isolated",diagnostic.PAYLOADS[3],Path(tmp),5)
            self.assertTrue(result["timed_out"]);self.assertFalse(result["ok"])
            self.assertEqual(result["timeout_seconds"],5)
            self.assertEqual(child.communicate.call_args_list,[mock.call(timeout=5),mock.call(timeout=1)])
            child.kill.assert_called_once()

    def test_fixed_sentinel_missing_stderr_or_incomplete_stage_cannot_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);marker=root/"powershell.exe-isolated-cmdlet-pipeline.marker"
            for output,errors,stage in [(b"",b"","entered;complete;"),(b"PILOT_SHELL_SENTINEL",b"failure","entered;complete;"),(b"PILOT_SHELL_SENTINEL",b"","entered;")]:
                child=mock.MagicMock();child.returncode=0;child.communicate.return_value=(output,errors);marker.write_text(stage)
                with mock.patch.object(subprocess,"CREATE_NO_WINDOW",0,create=True),mock.patch.object(subprocess,"Popen",return_value=child):
                    self.assertFalse(diagnostic.run_case(Path("powershell.exe"),"isolated",diagnostic.PAYLOADS[3],root,5)["ok"])

if __name__=="__main__":unittest.main()
