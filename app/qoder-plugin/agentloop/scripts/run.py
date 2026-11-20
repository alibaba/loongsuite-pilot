#!/usr/bin/env python3
"""兼容插件根入口；命令由 Setup Skill 的路由器执行。"""

import os
import subprocess
import sys


def main(argv):
    runner = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "skills", "agentloop-collector-setup", "scripts", "run.py",
    )
    return subprocess.run([sys.executable, runner, *argv]).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
