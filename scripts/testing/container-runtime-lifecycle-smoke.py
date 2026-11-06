#!/usr/bin/env python3
"""Compiled container lifecycle acceptance: temporary publisher deleted after installed ELF pin."""
import argparse,hashlib,json,os,re,shlex,shutil,subprocess,tempfile,uuid
from pathlib import Path
P=argparse.ArgumentParser(description=__doc__)
for flag in ["new-package","old-package","control-helper-binary","report"]:
 P.add_argument("--"+flag,type=Path,required=True)
P.add_argument("--image",required=True)
A=P.parse_args()
if not(re.fullmatch(r"sha256:[0-9a-f]{64}",A.image) or re.fullmatch(r"[A-Za-z0-9_./:-]+@sha256:[0-9a-f]{64}",A.image)):P.error("immutable image required")
def run(argv,input=None,env=None,cwd=None,check=True):
 p=subprocess.run([str(x) for x in argv],input=input,env=env,cwd=str(cwd) if cwd else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=70)
 if check and p.returncode:raise RuntimeError("rc={} stdout={} stderr={}".format(p.returncode,p.stdout.decode("utf8","replace")[-3000:],p.stderr.decode("utf8","replace")[-3000:]))
 return p
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def quote(s):return "'"+str(s).replace("'","'\"'\"'")+"'"
def snap(p):
 m=p.stat();return(p.read_bytes(),m.st_mtime_ns,m.st_mode&0o777,m.st_uid,m.st_gid)
def copy_package(source,destination):
 # Explicit manifest whitelist prevents accidental traversal into user state/config.
 raw=(source/"runtime-manifest.json").read_bytes();manifest=json.loads(raw)
 assert manifest["schema"]==1 and manifest["runtime"]=="rust"
 destination.mkdir(parents=True);(destination/"runtime-manifest.json").write_bytes(raw)
 for resource in manifest["resources"]:
  relative=Path(resource["path"])
  assert not relative.is_absolute() and ".." not in relative.parts
  assert relative.parts[0] in ("bin","assets","agents.d","scripts","VERSION","LICENSE")
  original=source/relative
  assert original.is_file() and not original.is_symlink() and source.resolve() in original.resolve().parents
  assert sha(original).lower()==resource["sha256"].lower()
  target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(str(original),str(target))
 return manifest
def package_hashes(package):
 return {str(p.relative_to(package)):sha(p) for p in package.rglob("*") if p.is_file()}
r={"fixtureOnly":True,"releaseCandidate":False,"cargoRun":False,"realInstallationTouched":False,"image":A.image}
cid=None
try:
 with tempfile.TemporaryDirectory(prefix="pilot-capability-rollback-") as directory:
  root=Path(directory);home=root/"home O'Brien 数据";cache=home/".loongsuite-pilot";data=cache;versions=cache/"versions";bin_dir=home/".local/bin"
  versions.mkdir(parents=True);bin_dir.mkdir(parents=True)
  source_manifests={}
  for name,source in [("legacy672",A.new_package),("legacy863",A.old_package)]:
   source_manifests[name]=copy_package(source,versions/name)
  immutable={name:package_hashes(versions/name) for name in source_manifests}
  temporary_helper=root/"temporary-unpacked"
  helper=temporary_helper/"bin/loongsuite-pilot";helper.parent.mkdir(parents=True)
  shutil.copy2(str(A.control_helper_binary),str(helper));helper.chmod(0o755)
  helper_hash=sha(helper);r["controlHelperSha256"]=helper_hash
  r["compiledGitCommit"]=None
  r["provenance"]="Debug/native ELF identity uses actual sha256 and check outer build fields. Modern fixture manifest Git SHA is all zeros, never a claimed build commit; immutable source packages remain unchanged."
  config=data/"config.json";config.write_bytes(b'\xef\xbb\xbf{\n "enabled": false,\n "autoUpdate": false,\n "logLevel": "error"\n}\n');config.chmod(0o640);config_before=snap(config)
  launcher=bin_dir/"loongsuite-pilot"
  (cache/"current").write_text("legacy672\n");(cache/"previous").write_text("legacy863\n")
  (cache/"init-type").write_text("systemd-system\n");init_before=(cache/"init-type").read_bytes()
  cid=run(["docker","create","--name","pilot-capability-fixture-"+uuid.uuid4().hex,"--pid","host","--network","host","--uts","host","--cgroupns","host","--init","--user",str(os.getuid())+":"+str(os.getgid()),"--label","loongsuite-pilot.data-dir="+str(data),"--mount","type=bind,src="+str(root)+",dst="+str(root),"--env","HOME="+str(home),"--env","LOONGSUITE_PILOT_DATA_DIR="+str(data),"--env","LOONGSUITE_PILOT_CACHE_DIR="+str(cache),"--env","AGENT_DATA_COLLECTION_CONFIG="+str(config),"--entrypoint","/bin/sleep",A.image,"infinity"]).stdout.decode().strip()
  run(["docker","start",cid]);r["containerId"]=cid
  glibc=run(["docker","exec",cid,"getconf","GNU_LIBC_VERSION"]).stdout.decode().strip()
  assert glibc=="glibc 2.34";r["glibc"]=glibc
  def direct(binary,args,input=None,check=True):
   return run(["docker","exec","-i","--workdir",str(root),cid,binary]+args,input=input,check=check)
  def options(source):return {"sourceDir":str(source),"cacheDir":str(cache),"dataDir":str(data),"configPath":str(config),"binDir":str(bin_dir)}
  def sync(source,check=True):return direct(helper,["installer-helper","sync-service"],json.dumps(options(source)).encode(),check)
  def bridge():return b"Managed Docker runtime" in launcher.read_bytes()
  def pin_to(binary):return ("LP_RUNTIME_HELPER="+quote(binary)).encode() in launcher.read_bytes()
  env=dict(PATH="/usr/bin:/bin",LANG="C.UTF-8",HOME=str(home),CODEX_HOME=str(home/".codex"),LOONGSUITE_PILOT_DATA_DIR=str(data),LOONGSUITE_PILOT_CACHE_DIR=str(cache),AGENT_DATA_COLLECTION_CONFIG=str(config))
  def host(args,input=None,cwd=root,check=True):return run([launcher]+args,input=input,env=env,cwd=cwd,check=check)
  identity=json.loads(direct(helper,["check","--json"],check=False).stdout)
  # Outer identity fields always come from the actual executable, even before its
  # private fixture manifest exists. No fake source tree or build SHA is supplied.
  for key in ["version","target","edition"]:assert isinstance(identity[key],str) and identity[key]
  r["actualBuildIdentity"]={key:identity[key] for key in ["version","target","edition"]}
  for name in ["modern-a","modern-b"]:
   pkg=versions/name;copy_package(versions/"legacy672",pkg)
   shutil.copy2(str(helper),str(pkg/"bin/loongsuite-pilot"))
   (pkg/"VERSION").write_text("version="+identity["version"]+"\ngit_commit="+"0"*40+"\n")
   resources=[{"path":str(p.relative_to(pkg)),"sha256":sha(p)} for p in sorted(pkg.rglob("*")) if p.is_file() and p.name!="runtime-manifest.json"]
   manifest={"schema":1,"runtime":"rust","version":identity["version"],"target":identity["target"],"edition":identity["edition"],"gitCommit":"0"*40,"binary":"bin/loongsuite-pilot","resources":resources}
   (pkg/"runtime-manifest.json").write_text(json.dumps(manifest))
   # Content assets/scripts/agent declarations are byte-for-byte from source package.
   for relative,digest in immutable["legacy672"].items():
    if relative not in ["bin/loongsuite-pilot","VERSION","runtime-manifest.json"]:assert sha(pkg/relative)==digest
  modern_hashes={name:package_hashes(versions/name) for name in ["modern-a","modern-b"]}
  modern_check=json.loads(direct(versions/"modern-a/bin/loongsuite-pilot",["check","--json"]).stdout)
  actual_caps=modern_check["check"]["details"].get("runtimeCapabilities")
  assert actual_caps=={"containerServiceHelper":1,"containerHookPin":1},"compiled helper lacks exact runtime capability contract"
  r["actualRuntimeCapabilities"]=actual_caps
  # No descriptor: retain native installs' existing ability to sync legacy source.
  sync(versions/"legacy863")
  assert not bridge() and snap(config)==config_before
  r["withoutDescriptorLegacySyncPreserved"]=True
  descriptor={"schema":1,"containerId":cid,"image":A.image,"dockerBinary":"/usr/bin/docker","launcherPath":str(launcher),"cacheDir":str(cache),"dataDir":str(data),"configPath":str(config),"uid":os.getuid(),"gid":os.getgid(),"startUpdater":False}
  dp=cache/"container-runtime.json";dp.write_text(json.dumps(descriptor));dp.chmod(0o600)
  # Mirror real installation: execute temporary ELF, but publish already-staged source.
  direct(helper,["installer-helper","publish-package"],json.dumps(options(versions/"modern-a")).encode())
  installed_a=versions/"modern-a/bin/loongsuite-pilot"
  assert bridge() and pin_to(installed_a)
  assert str(temporary_helper).encode() not in launcher.read_bytes()
  shutil.rmtree(str(temporary_helper))
  assert not temporary_helper.exists()
  helper=installed_a
  assert host(["--version"]).stdout.decode().strip()=="loongsuite-pilot "+identity["version"]
  after_delete=json.loads(host(["check","--json"]).stdout)
  assert after_delete["ok"] is True and Path(after_delete["check"]["details"]["resourceRoot"])==versions/"modern-a"
  r["temporaryPublisherRemovedInstalledCliStillWorks"]=True
  r["helperOrigin"]="Selected retained installed package ELF; no central debug or temporary helper survives"

  # A capable package is still forbidden as a sync source outside retained installed roots.
  outside=root/"outside-unpacked"
  copy_package(versions/"modern-b",outside)
  r["unsafeSyncSourcesRejected"]={}
  for label,candidate,reason in [
      ("temporary",outside,b"installed package directly in this cache/versions"),
      ("unretained",versions/"modern-b",b"retained by current or previous")]:
   before=(snap(launcher),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))
   rejected=sync(candidate,check=False)
   assert rejected.returncode!=0 and reason in rejected.stderr,(rejected.stdout,rejected.stderr)
   assert (snap(launcher),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))==before
   r["unsafeSyncSourcesRejected"][label]=True
  # Staging is allowed to read a temporary capable source, without pinning it or publishing.
  staged_name=direct(helper,["installer-helper","stage-package"],json.dumps(options(outside)).encode()).stdout.decode().strip()
  assert staged_name.startswith(".candidate-") and "/" not in staged_name
  assert (versions/staged_name/"bin/loongsuite-pilot").is_file()
  assert pin_to(installed_a) and not temporary_helper.exists()
  r["temporarySourceStageAllowedButSyncRejected"]=True
  r["legacyRejected"]={}
  for name in ["legacy672","legacy863"]:
   candidate=versions/name
   report=json.loads(direct(candidate/"bin/loongsuite-pilot",["check","--json"]).stdout)
   assert report["ok"] is True and report["check"]["details"].get("runtimeCapabilities") is None
   before=(snap(launcher),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))
   rejected=sync(candidate,check=False)
   assert rejected.returncode!=0 and "候选运行时不支持本安装的容器服务入口与 Hook pin".encode() in rejected.stderr
   assert (snap(launcher),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))==before
   r["legacyRejected"][name]={"gitCommit":source_manifests[name]["gitCommit"],"checkOk":True,"capabilitiesMissing":True,"syncRejectedBeforeWrites":True}
  # Load real native-generated shell function; only the role restart is suppressed.
  harness=root/"rollback.sh";restart_marker=root/"fixture-restart"
  harness.write_text("#!/bin/bash\nset -euo pipefail\nsource <(sed '/^# ---- Dispatch ----/,$d' "+shlex.quote(str(launcher))+") status\ncmd_restart() { printf '%s\\n' fixture-restart >> "+shlex.quote(str(restart_marker))+"; }\ncmd_rollback\n")
  def rollback():return run(["docker","exec","-i","--workdir",str(root),cid,"/bin/bash",harness],check=False)
  for name in ["legacy863","legacy672"]:
   (cache/"current").write_text("modern-a\n");(cache/"previous").write_text(name+"\n");sync(versions/"modern-a")
   before=(launcher.read_bytes(),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))
   rejected=rollback()
   assert rejected.returncode!=0 and "候选运行时不支持本安装的容器服务入口与 Hook pin".encode() in rejected.stderr
   assert (launcher.read_bytes(),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))==before
   assert not restart_marker.exists()
  r["legacyRollbackRestoresPointersWithoutRestart"]=True
  (cache/"current").write_text("modern-a\n");(cache/"previous").write_text("modern-b\n");sync(versions/"modern-a")
  toggles=[]
  for wanted in ["modern-b","modern-a","modern-b","modern-a"]:
   rolled=rollback();assert rolled.returncode==0,(rolled.stdout,rolled.stderr)
   assert (cache/"current").read_text().strip()==wanted and bridge() and pin_to(versions/wanted/"bin/loongsuite-pilot")
   checked=json.loads(host(["check","--json"]).stdout)
   assert checked["ok"] is True and checked["check"]["details"]["runtimeCapabilities"]==actual_caps
   assert Path(checked["check"]["details"]["resourceRoot"])==versions/wanted
   assert snap(config)==config_before
   toggles.append(wanted)
  assert len(restart_marker.read_text().splitlines())==4
  r["supportedCompiledRollbackToggles"]=toggles
  # Managed host helper may rebind to another retained package; neither pin is temporary.
  host(["installer-helper","sync-service"],json.dumps(options(versions/"modern-b")).encode())
  assert bridge() and pin_to(versions/"modern-b/bin/loongsuite-pilot")
  host(["installer-helper","sync-service"],json.dumps(options(versions/"modern-a")).encode())
  assert bridge() and pin_to(installed_a) and snap(config)==config_before
  assert not temporary_helper.exists()
  r["hostInstallerHelperRebindsOnlyRetainedInstalledPackages"]=True
  codex_home=home/".codex";codex_home.mkdir()
  hook_args=["--agents","codex","--home","codex="+str(codex_home),"--pilot-dir",str(versions/"modern-a"),"--json"]
  hooked=json.loads(host(["hook","install"]+hook_args).stdout)
  assert hooked["agents"][0]["status"]=="ok"
  assert (data/"hooks/pilot-bin").read_text().strip()==str(launcher)
  healthy=json.loads(host(["hook","status"]+hook_args).stdout);assert healthy["agents"][0]["status"]=="ok"
  r["modernHookPinHealthy"]=True
  missing_before=(launcher.read_bytes(),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))
  unavailable=helper.with_name("unavailable-control");helper.rename(unavailable)
  try:
   failed=rollback()
   assert failed.returncode!=0 and b"pinned container control helper unavailable" in failed.stderr
   assert (launcher.read_bytes(),(cache/"current").read_bytes(),(cache/"previous").read_bytes(),snap(config))==missing_before
  finally:unavailable.rename(helper)
  r["missingInstalledHelperFailsClosed"]=True
  denied=host(["--version"],cwd=Path("/usr"),check=False)
  assert denied.returncode!=0 and b"cwd is not covered by a same-absolute-path bind mount" in denied.stderr
  assert snap(config)==config_before and (cache/"init-type").read_bytes()==init_before
  assert not (data/"loongsuite-pilot.pid").exists() and not (data/"loongsuite-pilot-updater.pid").exists()
  for name,hashes in immutable.items():assert package_hashes(versions/name)==hashes
  for name,hashes in modern_hashes.items():assert package_hashes(versions/name)==hashes
  assert sha(installed_a)==helper_hash and not temporary_helper.exists()
  r.update(ok=True,configBytesModeOwnerMtimeUnchanged=True,immutableOriginalPackagesUnchanged=True,modernFixturesUnchangedAfterGeneration=True,updaterNeverStarted=True,collectorNeverStarted=True,unmountedCwdRejected=True)
except Exception as exc:
 r["ok"]=False;r["error"]=str(exc);raise
finally:
 if cid:r["containerRemoved"]=run(["docker","rm","-f",cid],check=False).returncode==0
 A.report.write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n")
 print(str(A.report))
