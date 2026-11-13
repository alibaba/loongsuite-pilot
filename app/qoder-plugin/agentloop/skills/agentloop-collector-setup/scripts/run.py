#!/usr/bin/env python3
"""install、audit、report、publish、auth 的总入口。尚未授权时先执行 auth，成功后再重试。"""

import os
import subprocess
import sys

_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILLS_DIR = os.path.dirname(os.path.dirname(_SCRIPTS_DIR))
_BUILDER_SCRIPTS_DIR = os.path.join(_SKILLS_DIR, "sls-dashboard-builder", "scripts")
_QUERY_SCRIPTS_DIR = os.path.join(_SKILLS_DIR, "agentloop-audit-query", "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from util.config_record import EXIT_NEED_AUTH

COMMANDS = {
    "install": os.path.join(_SCRIPTS_DIR, "install.py"),
    "audit": os.path.join(_QUERY_SCRIPTS_DIR, "query.py"),
    "report": os.path.join(_BUILDER_SCRIPTS_DIR, "render_report.py"),
    "publish": os.path.join(_BUILDER_SCRIPTS_DIR, "publish_dashboard.py"),
    "auth": os.path.join(_SCRIPTS_DIR, "ensure_oauth.py"),
}


def main(argv):
    if not argv:
        print("Usage: run.py install|audit|report|publish|auth [arguments...]", file=sys.stderr)
        return 1
    command = argv[0]
    target = COMMANDS.get(command)
    if not target:
        print("Unknown command: %s. Use install, audit, report, publish, or auth" % command, file=sys.stderr)
        return 1
    rest = argv[1:]
    status = subprocess.run([sys.executable, target, *rest]).returncode
    if command != "auth" and status == EXIT_NEED_AUTH:
        status = subprocess.run(
            [sys.executable, COMMANDS["auth"]],
            stdout=subprocess.DEVNULL,
        ).returncode
        if status == 0:
            status = subprocess.run([sys.executable, target, *rest]).returncode
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
