import json
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

DRAFT=Path(__file__).resolve().parents[2]/"src/deployment"
if not (DRAFT/"runtime_launcher_head.sh").exists():DRAFT=Path(__file__).parent
class RuntimeLauncherContracts(unittest.TestCase):
    def fixture(self,root):
        runtime=uuid.uuid4().hex+uuid.uuid4().hex
        data=root/"data";cache=root/"cache"
        data.mkdir();cache.mkdir()
        docker=root/"fake docker"
        docker.write_text("""#!/usr/bin/python3
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
if args[0]=='inspect':
 header=os.environ.get('FAKE_INSPECT_OVERRIDE',os.environ['EXPECTED_INSPECT'])
 root=str(Path(os.environ['ARGV_FILE']).parent)
 source=os.environ.get('FAKE_MOUNT_SOURCE',root)
 dest=os.environ.get('FAKE_MOUNT_DEST',root)
 sys.stdout.buffer.write(header.encode()+bytes([0])+b'1'+bytes([0])+b'bind'+bytes([0])+source.encode()+bytes([0])+dest.encode()+bytes([0,10]))
elif args[0]=='exec':
 Path(os.environ['ARGV_FILE']).write_text(json.dumps(args))
 Path(os.environ['STDIN_FILE']).write_bytes(sys.stdin.buffer.read())
 sys.stdout.write('{"hook":"complete"}\\\\n')
else:
 sys.exit(3)
""".replace("\\\\n","\\n"))
        docker.chmod(0o700)
        image="quay.io/rockylinux/rockylinux@sha256:"+"b"*64
        env=dict(os.environ)
        env.pop("LOONGSUITE_PILOT_CONTAINER_ID",None)
        env.update(LP_RUNTIME_ID=runtime,LP_RUNTIME_IMAGE=image,LP_RUNTIME_DOCKER=str(docker),
            LP_RUNTIME_LAUNCHER=str(root/"bin/loongsuite-pilot"),LP_RUNTIME_DATA=str(data),
            LP_RUNTIME_CACHE=str(cache),LP_RUNTIME_CONFIG=str(data/"config.json"),
            LP_RUNTIME_UID=str(os.getuid()),LP_RUNTIME_GID=str(os.getgid()),
            LOONGSUITE_PILOT_DATA_DIR=str(data),LOONGSUITE_PILOT_CACHE_DIR=str(cache),
            AGENT_DATA_COLLECTION_CONFIG=str(data/"config.json"),CODEX_HOME=str(root/"Codex home"),
            ARGV_FILE=str(root/"argv.json"),STDIN_FILE=str(root/"stdin"),
            EXPECTED_INSPECT=runtime+"|"+image+"|true|host|host|host|host|"+str(data))
        script=root/"host bridge.sh";script.write_text((DRAFT/"runtime_launcher_head.sh").read_text()+"\nexit 88\n")
        return script,env
    def test_host_bridge_keeps_raw_hook_stdin_stdout_cwd_and_argv_without_secret_env(self):
        with tempfile.TemporaryDirectory(prefix="pilot-runtime-argv-") as tmp:
            root=Path(tmp);script,env=self.fixture(root);env["GH_TOKEN"]="SYNTHETIC_NOT_FORWARDED"
            payload=b'{"message":"unicode \xe4\xb8\xad\xe6\x96\x87"}\n'
            result=subprocess.run(["/bin/bash",str(script),"hook-process","codex","space and 'quote'"],cwd=str(root),env=env,input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,b'{"hook":"complete"}\n')
            self.assertEqual((root/"stdin").read_bytes(),payload)
            args=json.loads((root/"argv.json").read_text())
            self.assertEqual(args[-3:],["hook-process","codex","space and 'quote'"])
            self.assertIn("CODEX_HOME",args);self.assertNotIn("GH_TOKEN",args)
            self.assertEqual(args[args.index("--workdir")+1],str(root))
            self.assertNotIn("/var/run/docker.sock"," ".join(args))
    def test_other_install_environment_never_calls_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);script,env=self.fixture(root);env["LOONGSUITE_PILOT_DATA_DIR"]="/different/install"
            result=subprocess.run(["/bin/bash",str(script),"status"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
            self.assertNotEqual(result.returncode,0);self.assertFalse((root/"argv.json").exists())
    def test_forged_container_context_does_not_bypass_cgroup_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);script,env=self.fixture(root);env["LOONGSUITE_PILOT_CONTAINER_ID"]=env["LP_RUNTIME_ID"]
            result=subprocess.run(["/bin/bash",str(script),"status"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
            self.assertNotEqual(result.returncode,0);self.assertIn(b"cgroup identity mismatch",result.stderr)
            self.assertFalse((root/"argv.json").exists())
    def test_wrong_container_image_or_role_namespace_is_rejected(self):
        for changed in ["false|host|host|host","true|private|host|host"]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);script,env=self.fixture(root)
                env["FAKE_INSPECT_OVERRIDE"]=env["EXPECTED_INSPECT"].replace("true|host|host|host",changed)
                result=subprocess.run(["/bin/bash",str(script),"status"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                self.assertNotEqual(result.returncode,0);self.assertFalse((root/"argv.json").exists())

    def test_existing_container_cwd_still_requires_same_absolute_bind_source(self):
        for mode in ["outside","other-source"]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);script,env=self.fixture(root)
                cwd=Path("/") if mode=="outside" else root
                if mode=="other-source":env["FAKE_MOUNT_SOURCE"]="/other/source"
                result=subprocess.run(["/bin/bash",str(script),"status"],cwd=str(cwd),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                self.assertNotEqual(result.returncode,0)
                self.assertIn(b"cwd is not covered by a same-absolute-path bind mount",result.stderr)
                self.assertFalse((root/"argv.json").exists())
    def test_container_service_mode_keeps_real_host_init_type_and_manager_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);runtime=uuid.uuid4().hex+uuid.uuid4().hex
            private=Path("/tmp")/("loongsuite-pilot-container-"+runtime+"-"+str(os.getuid()))
            host_init=root/"host-init-type";host_init.write_text("systemd-system\n")
            manager=root/"host-manager-called"
            script=root/"service-mode.sh"
            prelude="""set -euo pipefail
LP_RUNTIME_ID="$1"
LP_RUNTIME_UID="$2"
LP_RUNTIME_LAUNCHER=/synthetic/loongsuite-pilot
LP_RUNTIME_START_UPDATER=0
INIT_TYPE_FILE="$3"
ensure_dirs() { :; }
cmd_start_collector() { printf '%s\\\\n' collector; }
find_current_user_processes() { printf '%s\\\\n' 123; }
cmd_restart_updater() { printf '%s\\\\n' updater; }
autostart_remove() { touch "$4"; }
"""
            assertions="""
[[ "$INIT_TYPE_FILE" != "$3" ]]
[[ "$(read_init_type)" == nohup ]]
[[ "$(detect_init_system)" == none ]]
autostart_remove
cmd_start
"""
            script.write_text(prelude.replace("\\\\n","\\n")+(DRAFT/"runtime_launcher_tail.sh").read_text()+assertions)
            try:
                # status bypasses the tail's native-command exec while test inspects bindings.
                # Positional parameters are supplied via environment to avoid real CLI dispatch.
                source=script.read_text().replace('LP_RUNTIME_ID="$1"','LP_RUNTIME_ID="$RUNTIME_TEST_ID"').replace('LP_RUNTIME_UID="$2"','LP_RUNTIME_UID="$RUNTIME_TEST_UID"').replace('INIT_TYPE_FILE="$3"','INIT_TYPE_FILE="$RUNTIME_TEST_HOST_INIT"').replace('[[ "$INIT_TYPE_FILE" != "$3" ]]','[[ "$INIT_TYPE_FILE" != "$RUNTIME_TEST_HOST_INIT" ]]')
                script.write_text(source)
                env=dict(os.environ,RUNTIME_TEST_ID=runtime,RUNTIME_TEST_UID=str(os.getuid()),RUNTIME_TEST_HOST_INIT=str(host_init))
                result=subprocess.run(["/bin/bash",str(script),"status"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(result.stdout,b"collector\n")
                self.assertEqual(host_init.read_text(),"systemd-system\n");self.assertFalse(manager.exists())
                self.assertEqual((private/"init-type").read_text(),"nohup\n")
                self.assertEqual(private.stat().st_mode&0o777,0o700)
            finally:
                if private.exists():shutil.rmtree(str(private))
if __name__=="__main__":unittest.main()
