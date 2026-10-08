#!/usr/bin/env python3
"""Build and test a public artifact in a new full-system RISC-V guest (host entry)."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pilot_qemu', Path(__file__).with_name('qemu-env.py'))
qemu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qemu)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True, help='New directory, never a previous guest')
    parser.add_argument('--cache-dir', type=Path, help='Reusable, hash-checked download cache')
    parser.add_argument('--ssh-port', type=int, default=22227)
    parser.add_argument('--package', type=Path, help='Existing public tar.gz; otherwise build from current checkout')
    parser.add_argument('--keep-guest', action='store_true')
    args = parser.parse_args()
    work = args.work_dir.resolve()
    if work.exists():
        raise ValueError('Fresh run requires a new work directory; previous evidence must be retained')
    work.mkdir(parents=True)
    (work / 'guest').mkdir()
    cache = args.cache_dir.resolve() if args.cache_dir else work / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    if cache != work / 'cache':
        (work / 'cache').symlink_to(cache, target_is_directory=True)
    manifest = json.loads((ROOT / 'scripts/riscv64/environment.lock.json').read_text())
    manifest['qemu']['ssh_port'] = args.ssh_port
    result = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'status': 'failed', 'work_dir': str(work), 'steps': [], 'live_model': False}
    result['source_commit'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    result['tracked_source_dirty'] = bool(subprocess.check_output(
        ['git','status','--porcelain','--untracked-files=no'],cwd=ROOT,text=True).strip())
    result['host_qemu'] = subprocess.check_output(['qemu-system-riscv64','--version'],text=True,timeout=10).strip()
    firmware = Path('/usr/share/qemu/opensbi-riscv64-generic-fw_dynamic.bin')
    if firmware.is_file():
        result['host_firmware'] = {'path':str(firmware),'sha256':qemu.digest(firmware)}

    def run(label, argv, timeout=300, stdout_file=None):
        print('+', label, shlex.join(str(v) for v in argv), flush=True)
        started = time.monotonic()
        with (stdout_file or work / f'{label}.log').open('wb') as log:
            completed = subprocess.run([str(v) for v in argv], cwd=ROOT,
                                       stdout=log, stderr=None if stdout_file else subprocess.STDOUT,
                                       timeout=timeout)
        result['steps'].append({'label': label, 'exit_code': completed.returncode,
                                'elapsed_seconds': round(time.monotonic()-started, 2)})
        if completed.returncode:
            raise RuntimeError(f'{label} failed ({completed.returncode}); inspect {label}.log')

    def ssh(label, argv, timeout=300, stdout_file=None):
        run(label, qemu.ssh_args(work, manifest) + [shlex.join(str(v) for v in argv)], timeout, stdout_file)

    def copy(label, files, destination):
        run(label, ['scp', '-i', work / 'guest/id_ed25519', '-P', str(args.ssh_port),
                    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o',
                    f'UserKnownHostsFile={work / "guest/known_hosts"}', *files,
                    f'{manifest["qemu"]["ssh_user"]}@127.0.0.1:{destination}'], 600)

    ready = False
    try:
        negative = work / 'checksum-negative'
        (negative / 'cache').mkdir(parents=True)
        (negative / 'cache/bad.tar.xz').write_bytes(b'intentionally corrupted cached input')
        try:
            qemu.download(negative, {'url':'https://invalid.example/bad.tar.xz','sha256':'0'*64})
        except RuntimeError as error:
            if 'Cached asset checksum mismatch' not in str(error):
                raise
            result['checksum_rejection']={'status':'passed','network_used':False,'error':str(error)}
        else:
            raise RuntimeError('Checksum-negative input was accepted')
        if args.package:
            package = args.package.resolve()
        else:
            package = work / 'pilot.tar.gz'
            run('package', ['bash', 'deploy/package-opensource.sh', '--output', package], 600)
        result['package_sha256'] = qemu.digest(package)
        run('upgrade-fixtures', ['python3', 'scripts/riscv64/make-upgrade-fixtures.py',
                                 '--base', package, '--output-dir', work / 'upgrade-fixtures'], 300)
        qemu.prepare(work, manifest)
        agent = manifest['agents']['primary']
        agent_archive = cache / 'qwen-code-0.23.2.tgz'
        if not agent_archive.exists():
            run('download-agent', ['curl', '--fail', '--location', '--retry', '2', '--connect-timeout', '15',
                                   '--max-time', '600', '--output', str(agent_archive)+'.part', agent['tarball']], 650)
            Path(str(agent_archive)+'.part').rename(agent_archive)
        algorithm, expected = agent['integrity'].split('-', 1)
        actual = base64.b64encode(hashlib.new(algorithm, agent_archive.read_bytes()).digest()).decode()
        if actual != expected:
            raise ValueError('Qwen CLI integrity mismatch; archive will not be executed')
        result['agent_integrity'] = agent['integrity']
        qemu.start(work, manifest)
        ready = True
        guest_home = f'/home/{manifest["qemu"]["ssh_user"]}'
        ssh('guest-directories', ['mkdir', '-p', f'{guest_home}/inputs', f'{guest_home}/runtimes', f'{guest_home}/driver', f'{guest_home}/evidence'])
        copy('copy-runtime', [qemu.asset_path(work, manifest['assets'][key]) for key in ('node22','node18')], f'{guest_home}/inputs/')
        # Stable guest filenames do not depend on the caller's package basename.
        copy('copy-package', [package], f'{guest_home}/inputs/pilot.tar.gz')
        copy('copy-fixtures', [work / 'upgrade-fixtures/pilot-riscv64-b.tar.gz', work / 'upgrade-fixtures/pilot-riscv64-bad.tar.gz',
                              work / 'upgrade-fixtures/pilot-riscv64-deps-bad.tar.gz',
                              ROOT / 'deploy/installer-opensource.sh', agent_archive], f'{guest_home}/inputs/')
        node22 = f'{guest_home}/runtimes/node-v22.22.2-linux-riscv64/bin/node'
        node18 = f'{guest_home}/runtimes/node-v18.20.8-linux-riscv64/bin/node'
        setup = f'''set -euo pipefail
cd {shlex.quote(guest_home)}
tar -xJf inputs/node-v22.22.2-linux-riscv64.tar.xz -C runtimes
tar -xJf inputs/node-v18.20.8-linux-riscv64.tar.xz -C runtimes
tar -xzf inputs/pilot.tar.gz -C driver --strip-components=1
mkdir -p qwen-code .qwen .local/bin
tar -xzf inputs/qwen-code-0.23.2.tgz -C qwen-code
cat > .qwen/settings.json <<'JSON'
{{"general":{{"disableAutoUpdate":true}},"telemetry":{{"enabled":false}},"tools":{{"useRipgrep":false,"shell":{{"enableInteractiveShell":false}}}}}}
JSON
cat > .local/bin/qwen <<'SH'
#!/usr/bin/env bash
exec {shlex.quote(node22)} {shlex.quote(guest_home+'/qwen-code/package/cli-entry.js')} "$@"
SH
chmod +x .local/bin/qwen
export PATH={shlex.quote(str(Path(node22).parent))}:{shlex.quote(guest_home+'/.local/bin')}:/usr/local/bin:/usr/bin:/bin
bash driver/scripts/riscv64/bootstrap-guest.sh {shlex.quote(guest_home+'/evidence/environment')}
'''
        (work / 'guest-setup.sh').write_text(setup)
        copy('copy-setup', [work / 'guest-setup.sh'], f'{guest_home}/inputs/')
        ssh('guest-setup', ['bash', f'{guest_home}/inputs/guest-setup.sh'], 1800)
        path_env = f'PATH={Path(node22).parent}:{guest_home}/.local/bin:/usr/local/bin:/usr/bin:/bin'
        ssh('installed-all', ['env', path_env, 'bash', f'{guest_home}/driver/scripts/riscv64/smoke.sh',
                             '--case', 'all', '--data-dir', f'{guest_home}/pilot-data',
                             '--artifacts', f'{guest_home}/evidence/installed', '--package', f'{guest_home}/inputs/pilot.tar.gz',
                             '--installer', f'{guest_home}/inputs/installer-opensource.sh',
                             '--package-b', f'{guest_home}/inputs/pilot-riscv64-b.tar.gz',
                             '--package-bad', f'{guest_home}/inputs/pilot-riscv64-bad.tar.gz',
                             '--package-deps-bad', f'{guest_home}/inputs/pilot-riscv64-deps-bad.tar.gz',
                             '--agent-entry', f'{guest_home}/qwen-code/package/cli-entry.js',
                             '--agent-node', node22, '--node18', node18], 150*60)
        result['status'] = 'passed'
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        if ready:
            try:
                guest_home = f'/home/{manifest["qemu"]["ssh_user"]}'
                stop_script = f'if [ -x {shlex.quote(guest_home+"/.local/bin/loongsuite-pilot")} ]; then LOONGSUITE_PILOT_DATA_DIR={shlex.quote(guest_home+"/pilot-data")} {shlex.quote(guest_home+"/.local/bin/loongsuite-pilot")} stop; fi'
                ssh('stop-before-archive',['bash','-c',stop_script],180)
                # Stop the collector before archiving its changing log/state files.
                archive_script = ('import pathlib,subprocess,sys; base=pathlib.Path(sys.argv[1]); '
                                  'names=[p for p in ["evidence","pilot-data/logs","pilot-data/native-capabilities.json"] if (base/p).exists()]; '
                                  'sys.exit(subprocess.call(["tar","-czf","-","-C",str(base),*names]))')
                ssh('collect-evidence', ['python3','-c',archive_script,guest_home],300,work/'guest-evidence.tar.gz')
            except Exception as error:
                result['evidence_collection_error'] = str(error)
                result['status'] = 'failed'
        if not args.keep_guest:
            try:
                qemu.stop(work)
            except Exception as error:
                result['cleanup_error'] = str(error)
                result['status'] = 'failed'
        result['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (work / 'result.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
