# Embedding Pilot in a Node or Python launcher

Launchers should preserve the business process's working directory when starting
the collector. Agent entry discovery uses that directory as well as `PATH` and
explicit Agent configuration.

`npm run build` ships two dependency-free policy modules:

| Module | Node API | Python API |
| --- | --- | --- |
| `dist/runtime/root-trigger.cjs` / `dist/runtime/root_trigger.py` | `collectorCwd()` | `collector_cwd()` |
| | `reuseRootCollector(dataDir, daemonEntry)` | `reuse_root_collector(data_dir, daemon_entry)` |
| | `prepareCoordinationFile(fd)` | `prepare_coordination_file(fd)` |
| | `atomicClaim(target, payload)` | `atomic_claim(target, payload)` |

Use the working-directory result for the collector child's `cwd`. Keep the
Agent's command and arguments intact.

Before an unprivileged trigger pins a runtime, injects plugins or acquires locks,
call the reuse check with the absolute data directory and collector entry. A
`true` result means a root-owned coordination file identifies the running
collector, or contains a fresh empty spawn claim. Reuse that collector and leave
its installation and locks intact. Invalid, stale, unreadable, symlink or special
files return `false`; PID and process command reads are bounded.
A positive result skips Pilot initialization, not the Agent's main program.

Call the coordination helper on an open PID/sentinel descriptor before publishing
it. Only explicit root-trigger mode changes its permissions to `0644`, including
under a restrictive umask. Never apply this helper to config, credentials or
event files. Launchers must retain their existing exception handling so a startup
failure cannot prevent the business process from running.

Launchers can reuse the complete atomic-claim helper instead of creating the
descriptor themselves. It returns `false` when another claim already exists,
retains the empty-claim fallback on filesystems without hardlinks, and removes
its temporary file on exit. Other I/O failures are propagated to the launcher's
existing failure handler.

These helpers have no startup side effects and do not launch an Agent or a
collector themselves. `LOONGSUITE_PILOT_ROOT_TRIGGER=1` enables the explicit root
policy; it does not grant privileges or change the business process's UID. The
launcher remains responsible for deciding which process is eligible to trigger
Pilot and for packaging and calling these modules.

On Linux, for OpenClaw, Hermes and DSH sharing their existing configuration roots, Pilot
prepares sticky shared event directories while each writer keeps its files
private (`0600`). The root collector must be permitted to read those files.
This does not discover independent per-user configuration roots or make a
non-root collector capable of reading another UID's private files.
The shared runtime/data path must also be traversable and readable by the
participating UIDs; these policies do not make a private root home public.
