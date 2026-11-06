import importlib.util
import unittest
from pathlib import Path
from unittest import mock
spec = importlib.util.spec_from_file_location("preflight", str(Path(__file__).with_name("container_preflight.py")))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

class ContainerPreflightContracts(unittest.TestCase):
    def test_fixed_glibc234_image_and_same_absolute_package_paths(self):
        package = Path("/tmp/isolated candidate")
        home = Path("/tmp/synthetic home")
        argv = preflight.arguments(package, home, "x86_64-unknown-linux-gnu", "own", ["check", "--json"])
        self.assertIn("--network", argv)
        self.assertIn("none", argv)
        self.assertIn("type=bind,src=/tmp/isolated candidate,dst=/tmp/isolated candidate,readonly", argv)
        self.assertIn("type=bind,src=/tmp/synthetic home,dst=/tmp/synthetic home,readonly", argv)
        self.assertIn("--entrypoint", argv)
        self.assertEqual(argv[-2:], ["check", "--json"])
        self.assertIn("@sha256:", argv[-3])
        self.assertNotIn("--pid=host", argv)
        self.assertFalse(any("LD_LIBRARY_PATH" in value or "LD_PRELOAD" in value for value in argv))
        self.assertFalse(any("/root/.loongsuite-pilot" in value for value in argv))

    def test_check_accepts_only_structured_informational_stderr_and_keeps_stdout_protocol(self):
        for diagnostic, accepted in [
            (b'{"level":"INFO","msg":"loaded synthetic config"}' + bytes([10]), True),
            (b'{"level":"WARN","msg":"invalid config"}' + bytes([10]), False),
            (b'unstructured error', False),
        ]:
            result = mock.Mock(stdout=b'{"ok":true}', stderr=diagnostic)
            with mock.patch.object(preflight.subprocess, "run", side_effect=[result, mock.Mock()]) as run:
                if accepted:
                    self.assertEqual(preflight.bounded_container(["docker", "run"], "own-uuid", allow_info=True), '{"ok":true}')
                else:
                    with self.assertRaises(ValueError):
                        preflight.bounded_container(["docker", "run"], "own-uuid", allow_info=True)
                self.assertEqual(run.call_args_list[-1][0][0], ["docker", "rm", "-f", "own-uuid"])

    def test_success_and_failure_always_reap_only_owned_container(self):
        for fails in [False, True]:
            success = mock.Mock(stdout=b"protocol", stderr=b"")
            responses = [RuntimeError("synthetic failure") if fails else success, mock.Mock()]
            with mock.patch.object(preflight.subprocess, "run", side_effect=responses) as run:
                if fails:
                    with self.assertRaises(RuntimeError):
                        preflight.bounded_container(["docker", "run"], "own-uuid")
                else:
                    self.assertEqual(preflight.bounded_container(["docker", "run"], "own-uuid"), "protocol")
                self.assertEqual(run.call_args_list[-1][0][0], ["docker", "rm", "-f", "own-uuid"])
                self.assertEqual(run.call_args_list[0][1]["timeout"], 35)

if __name__ == "__main__":
    unittest.main()
