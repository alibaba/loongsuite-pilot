# Copyright 2026 Alibaba Group Holding Limited
# SPDX-License-Identifier: Apache-2.0
"""Standard-library-only policy for embedding Python launchers.

No startup side effects. Launchers retain their own discovery and spawn flow.
"""
import os
import re
import stat
import sys
import time


def root_trigger_enabled():
    return str(os.environ.get('LOONGSUITE_PILOT_ROOT_TRIGGER', '')).strip().lower() in ('1', 'true', 'yes', 'on')


def collector_cwd():
    return os.getcwd()


def prepare_coordination_file(fd):
    """Only for PID/sentinel descriptors, never config or event files."""
    if hasattr(os, 'getuid') and os.getuid() == 0 and root_trigger_enabled():
        os.fchmod(fd, 0o644)


def atomic_claim(target, payload):
    """Publish PID/sentinel coordination state without replacing another claim."""
    temporary = '%s.%s.%s.tmp' % (target, os.getpid(), time.monotonic_ns())
    created = False
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
        created = True
        with os.fdopen(fd, 'w') as stream:
            stream.write(payload)
            prepare_coordination_file(stream.fileno())
        try:
            os.link(temporary, target)
            return True
        except FileExistsError:
            return False
        except OSError:
            # Preserve the existing empty-claim stale recovery protocol on
            # filesystems which do not support hardlinks.
            try:
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
            except FileExistsError:
                return False
            try:
                prepare_coordination_file(fd)
            finally:
                os.close(fd)
            return True
    finally:
        if created:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def reuse_root_collector(data_dir, daemon_entry):
    if sys.platform != 'linux' or not hasattr(os, 'getuid') or os.getuid() == 0 or not root_trigger_enabled():
        return False
    fd = None
    try:
        fd = os.open(os.path.join(data_dir, 'daemon.spawn.lock'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_size > 64:
            return False
        value = os.read(fd, 65)
        if len(value) > 64:
            return False
        pid = value.decode('utf-8').strip()
        if not pid:
            age = time.time() - info.st_mtime
            return 0 <= age < 60
        if not re.fullmatch(r'[1-9][0-9]*', pid):
            return False
        with open('/proc/%s/cmdline' % pid, 'rb') as command:
            return daemon_entry in command.read(4096).decode('utf-8', 'replace').split('\0')
    except (OSError, ValueError):
        return False
    finally:
        if fd is not None:
            os.close(fd)
