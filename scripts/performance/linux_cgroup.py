"""Locate an owned Docker process's v1/v2 cgroup using public procfs metadata."""
from pathlib import Path
import re


def unescape(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def locate(pid, proc_root=Path("/proc")):
    memberships = []
    for line in (proc_root / str(pid) / "cgroup").read_text().splitlines():
        hierarchy, controllers, relative = line.split(":", 2)
        memberships.append((hierarchy, set(controllers.split(",")) if controllers else set(), Path(relative)))
    mounts = []
    for line in (proc_root / "self/mountinfo").read_text().splitlines():
        before, after = line.split(" - ", 1)
        fields, filesystem = before.split(), after.split()
        if filesystem[0] in ("cgroup", "cgroup2"):
            mounts.append((filesystem[0], Path(unescape(fields[3])), Path(unescape(fields[4])),
                           set(filesystem[2].split(","))))

    def directory(membership, mount):
        try:
            return mount[2] / membership[2].relative_to(mount[1])
        except ValueError:
            return None

    for membership in memberships:
        if membership[0] != "0" or membership[1]:
            continue
        for mount in mounts:
            if mount[0] != "cgroup2":
                continue
            path = directory(membership, mount)
            if path is not None and (path / "cgroup.procs").is_file():
                return {"version": "v2", "processes": path / "cgroup.procs",
                        "memory_peak": path / "memory.peak", "memory_usage": path / "memory.current"}
    found = {}
    for controller in ("memory", "cpuacct", "cpu"):
        for membership in memberships:
            if controller not in membership[1]:
                continue
            for mount in mounts:
                if mount[0] == "cgroup" and controller in mount[3]:
                    path = directory(membership, mount)
                    if path is not None and (path / "cgroup.procs").is_file():
                        found[controller] = path
                        break
    selected = next((found[name] for name in ("memory", "cpuacct", "cpu") if name in found), None)
    if selected is None:
        raise RuntimeError("infrastructure: cannot locate owned v1/v2 cgroup process list")
    memory = found.get("memory")
    return {"version": "v1", "processes": selected / "cgroup.procs",
            "memory_peak": memory / "memory.max_usage_in_bytes" if memory else None,
            "memory_usage": memory / "memory.usage_in_bytes" if memory else None}
