# Copilot disk-governance stress

Run the opt-in suite from the repository with Node.js supporting unflagged
`node:sqlite` (22.13+ or 23.4+):

```sh
PILOT_DISK_STRESS=1 \
PILOT_DISK_STRESS_REPORT=/tmp/pilot-disk-stress.json \
npx vitest run tests/performance/copilot-disk-governance.perf.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=dot
```

The regular test suite skips these pressure cases. All transcripts, native OTel,
SQLite indexes, and output files are synthetic, live in unique temporary
directories, and are removed even on assertion failure. The optional JSON report
is retained at the explicitly requested path. No real Agent or network exporter
is started, and installed user data is not used.

The suite validates:

- First activation over 1,024 historical interactions with 64 KiB prompts emits
  no historical output. Rebuilding only the test's SQLite index keeps the same
  adoption policy; 128 new interactions appended to that old session still emit.
- Controlled replay of 128/256/512 interactions with 16 KiB prompts exercises
  real `CopilotLogInput -> SQLite -> InputManager -> JsonlFlusher`, reports
  elapsed time, sampled worker RSS, event-loop p99, and unique event IDs, and
  requires linear normalized output and no additional output after idle/restart.
- 64 concurrent producers emit 8,192 UTF-8 records through the actual JSONL
  writer. Every record must parse and have a unique ID across 1 MiB segments.
- One 64-step interaction with tool results goes through the actual Trace
  converter/debug writer and a memory exporter. Native per-call Token usage is
  checked; this distinguishes bounded file storage from the converter's
  reconstruction of within-interaction request context.
- Sparse files test three managed directories with files strictly over 3 GiB,
  plus 128 closed 32 MiB segments dated today. Real cleanup must remove the giant
  files and reclaim output from 4 GiB to the existing 2 GiB target.

The 1 MiB JSONL limit makes frequent rotations practical; the production default
remains 100 MiB. Sparse tests validate logical-size thresholds and deletion, **not
physical 3 GiB write throughput**. Worker RSS includes Vitest and preceding
scenarios. Mock exporter success does not establish production SLS/OTLP delivery.
The 60-second pressure sweep and protected ordinary active files mean directory
targets are soft periodic budgets, not instantaneous disk quotas. Source files
are never deleted by the implementation; pressure may discard local failed
evidence with a warning. Detailed timing results belong in the PR validation
record for the actual tested revision and machine.
