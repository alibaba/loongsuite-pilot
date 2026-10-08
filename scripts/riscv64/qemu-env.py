#!/usr/bin/env python3
"""Isolated full-system RISC-V guest; all state stays in the supplied work directory."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]


def run(argv, **kwargs):
    print('+', shlex.join(str(x) for x in argv), flush=True)
    return subprocess.run([str(x) for x in argv], check=True, **kwargs)


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def asset_path(work, asset):
    name = Path(urlparse(asset['url']).path).name
    if not name or not re.fullmatch('[0-9a-f]{64}', asset['sha256']):
        raise ValueError('Invalid asset filename or SHA256')
    return work / 'cache' / name


def download(work, asset):
    final = asset_path(work, asset)
    expected = asset['sha256']
    if final.exists():
        if digest(final) != expected:
            raise RuntimeError(f'Cached asset checksum mismatch: {final}')
        print(f'CHECKSUM OK {final.name}', flush=True)
        return
    partial = final.with_name(final.name + '.part')
    # A previous completed manual/resumable download can be adopted after validation.
    if not partial.exists() or digest(partial) != expected:
        run(['curl', '--fail', '--location', '--continue-at', '-', '--retry', '2',
             '--connect-timeout', '15', '--max-time', '1800', '--speed-limit', '1024',
             '--speed-time', '60', '--output', partial, asset['url']])
    actual = digest(partial)
    if actual != expected:
        raise RuntimeError(f'Checksum mismatch: {partial}; expected {expected}, got {actual}')
    partial.rename(final)
    print(f'CHECKSUM OK {final.name}', flush=True)


def owned_pid(work):
    pidfile = work / 'guest' / 'qemu.pid'
    if not pidfile.exists():
        return None
    pid = int(pidfile.read_text().strip())
    try:
        cmd = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    except FileNotFoundError:
        return None
    # Refuse to signal a reused PID or a different guest.
    if not cmd or b'qemu-system-riscv64' not in cmd[0] or str(pidfile).encode() not in cmd:
        raise RuntimeError(f'PID {pid} does not belong to this guest; refusing to use it')
    return pid


def ssh_args(work, manifest):
    qemu = manifest['qemu']
    return ['ssh', '-i', str(work / 'guest' / 'id_ed25519'), '-p', str(qemu['ssh_port']),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', f'UserKnownHostsFile={work / "guest" / "known_hosts"}',
            f'{qemu["ssh_user"]}@127.0.0.1']


def prepare(work, manifest):
    if owned_pid(work):
        raise RuntimeError('Stop this guest before preparing its disk/configuration')
    for asset in manifest['assets'].values():
        download(work, asset)
    guest = work / 'guest'
    key = guest / 'id_ed25519'
    if not key.exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key])
    public_key = key.with_suffix('.pub').read_text().strip()
    user = manifest['qemu']['ssh_user']
    if not re.fullmatch('[a-z][a-z0-9_-]*', user):
        raise ValueError('Invalid guest user')
    (guest / 'user-data').write_text(
        '#cloud-config\nhostname: pilot-riscv64\nmanage_etc_hosts: true\n'
        'ssh_pwauth: false\ndisable_root: true\nusers:\n'
        f'  - name: {user}\n    shell: /bin/bash\n    lock_passwd: true\n'
        '    sudo: ["ALL=(ALL) NOPASSWD:ALL"]\n    groups: [adm, sudo]\n'
        f'    ssh_authorized_keys:\n      - {public_key}\n'
        'runcmd:\n  - [touch, /var/lib/pilot-bootstrap-ready]\n')
    instance = hashlib.sha256(str(work).encode()).hexdigest()[:16]
    (guest / 'meta-data').write_text(f'instance-id: pilot-{instance}\nlocal-hostname: pilot-riscv64\n')
    (guest / 'network-config').write_text(
        'version: 2\nethernets:\n  main:\n    match:\n      name: "e*"\n    dhcp4: true\n')
    run(['xorriso', '-as', 'mkisofs', '-quiet', '-V', 'cidata', '-J', '-r',
         '-o', guest / 'seed.iso', guest / 'user-data', guest / 'meta-data', guest / 'network-config'])
    disk = guest / 'disk.qcow2'
    if not disk.exists():
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b',
             asset_path(work, manifest['assets']['disk']), disk])
        run(['qemu-img', 'resize', disk, manifest['qemu']['disk_size']])
    (work / 'environment.lock.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('PREPARED: checked downloads, overlay disk, SSH key and cloud-init seed', flush=True)


def start(work, manifest):
    qemu = manifest['qemu']
    guest = work / 'guest'
    if not (guest / 'disk.qcow2').exists():
        raise RuntimeError('Run prepare-env.sh first')
    if not owned_pid(work):
        # Each start checks the immutable boot assets, even when reusing an overlay.
        for name in ('disk', 'kernel', 'initrd'):
            asset = manifest['assets'][name]
            if digest(asset_path(work, asset)) != asset['sha256']:
                raise RuntimeError(f'Boot asset checksum mismatch: {name}')
        run(['qemu-system-riscv64', '-machine', qemu['machine'], '-accel', qemu['accelerator'],
             '-smp', str(qemu['cpus']), '-m', str(qemu['memory_mib']), '-bios', 'default',
             '-kernel', asset_path(work, manifest['assets']['kernel']),
             '-initrd', asset_path(work, manifest['assets']['initrd']),
             '-append', 'console=ttyS0 root=LABEL=cloudimg-rootfs rw',
             '-drive', f'file={guest / "disk.qcow2"},if=virtio,format=qcow2',
             '-drive', f'file={guest / "seed.iso"},if=virtio,format=raw,readonly=on',
             '-netdev', f'user,id=net0,hostfwd=tcp:127.0.0.1:{qemu["ssh_port"]}-:22',
             '-device', 'virtio-net-device,netdev=net0', '-display', 'none',
             '-serial', f'file:{guest / "console.log"}', '-monitor', 'none',
             '-pidfile', guest / 'qemu.pid', '-daemonize'])
    started = time.monotonic()
    deadline = started + qemu['boot_timeout_seconds']
    with (guest / 'ssh-wait.log').open('a') as log:
        while time.monotonic() < deadline:
            if not owned_pid(work):
                raise RuntimeError('QEMU exited before SSH was ready; inspect console.log')
            probe = subprocess.run(ssh_args(work, manifest) + ['test -f /var/lib/pilot-bootstrap-ready'],
                                   stdout=log, stderr=log, timeout=15)
            if probe.returncode == 0:
                run(ssh_args(work, manifest) + ['uname -m; cat /etc/os-release; ps -p 1 -o comm='])
                print(f'GUEST READY after {time.monotonic() - started:.1f}s', flush=True)
                return
            print(f'Waiting for guest/cloud-init: {time.monotonic() - started:.0f}s', flush=True)
            time.sleep(5)
    raise RuntimeError(f'Guest readiness exceeded {qemu["boot_timeout_seconds"]}s; inspect console.log')


def stop(work):
    pid = owned_pid(work)
    if not pid:
        print('Guest already stopped')
        return
    # SIGTERM is only sent after validating ownership, with a bounded wait.
    os.kill(pid, signal.SIGTERM)
    for _ in range(60):
        if not Path(f'/proc/{pid}').exists() or Path(f'/proc/{pid}/stat').read_text().split()[2] == 'Z':
            (work / 'guest' / 'qemu.pid').unlink(missing_ok=True)
            print('Guest stopped')
            return
        time.sleep(0.5)
    raise RuntimeError('QEMU did not stop in 30s; no unrelated processes were signalled')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'start', 'ssh', 'stop'])
    parser.add_argument('--manifest', type=Path, default=ROOT / 'scripts/riscv64/environment.lock.json')
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'e2e-artifacts/riscv64')
    # Parse remote commands separately so options such as bash -lc remain intact.
    argv = sys.argv[1:]
    remote = []
    if '--' in argv:
        split = argv.index('--')
        argv, remote = argv[:split], argv[split + 1:]
    args = parser.parse_args(argv)
    work = args.work_dir.resolve()
    if ',' in str(work):
        raise ValueError('Work directory must not contain commas (QEMU option delimiter)')
    for directory in ('cache', 'guest'):
        (work / directory).mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text())
    if manifest.get('schema') != 1:
        raise ValueError('Unsupported environment lock schema')
    if args.action == 'prepare':
        prepare(work, manifest)
    elif args.action == 'start':
        start(work, manifest)
    elif args.action == 'stop':
        stop(work)
    else:
        if not owned_pid(work):
            raise RuntimeError('Guest is not running')
        run(ssh_args(work, manifest) + ([shlex.join(remote)] if remote else []))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(exc.returncode if isinstance(exc, subprocess.CalledProcessError) else 1)
