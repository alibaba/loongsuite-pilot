# Qoder / QoderCN bounded transcript collection

## Comparison target

Measured on 2026-10-31, macOS 26.3.2 / arm64 / 48 GiB, using the same
Node 22.22.2 for the original shell wrappers and the candidate parser worker.
Baseline: `f84e3881958b39c5c7cbe8a035f50ccd80a25783`. Production implementation:
`5dbc09b905630f5047012f5d58db72034014c3a3`.

The architecture follows Codex's thin Hook and collector-owned processing
([#69](https://github.com/alibaba/loongsuite-pilot/pull/69)), incremental recovery
([#153](https://github.com/alibaba/loongsuite-pilot/pull/153)), and bounded cache
precedents ([#405](https://github.com/alibaba/loongsuite-pilot/pull/405),
[#431](https://github.com/alibaba/loongsuite-pilot/pull/431)). Qoder's native
message/tool boundaries and its existing token enrichment remain authoritative.

Reproduce from an isolated baseline asset checkout and a fresh output directory:

```sh
node tests/performance/qoder-transcript.perf.mjs \
  /absolute/baseline/assets/hooks /absolute/new-results /absolute/node22
```

The runner records source hashes, raw samples, read bytes, child starts, CPU
usage and RSS in `results.json`. `--natural-only` runs just the evolving
three-tool case. All fixtures are synthetic; it neither calls a model nor tries
to reproduce memory exhaustion or an OS watchdog reset.

## Wrapper and parser resources

Each size/product/revision has three independent runs. A run contains a cold
Stop, three unchanged notifications, and a Stop after one small appended Turn.
Wall time covers the complete shell wrapper, Node lookup/startup and exit.
Candidate parsing runs separately in one persistent collector worker. Both sides
include transcript parsing; token database joins and trace export are validated
separately. Small-file timings include process-startup noise.

| Product | History | Cold wrapper median, before → after | Unchanged wrapper median, before → after | Maximum single-process RSS, before → after |
| --- | --- | --- | --- | --- |
| Qoder | 1 MiB | 74.3 → 68.2 ms | 60.5 → 57.7 ms | 60.1 → 53.8 MiB |
| Qoder | 8 MiB | 86.8 → 72.3 ms | 75.0 → 54.2 ms | 114.8 → 53.6 MiB |
| Qoder | 32 MiB | 155.0 → 80.8 ms | 109.0 → 56.2 ms | 274.7 → 53.5 MiB |
| QoderCN | 1 MiB | 63.7 → 64.7 ms | 57.8 → 53.5 ms | 60.1 → 53.5 MiB |
| QoderCN | 8 MiB | 85.0 → 76.3 ms | 71.1 → 53.6 ms | 114.5 → 53.6 MiB |
| QoderCN | 32 MiB | 175.7 → 78.0 ms | 110.5 → 54.6 ms | 272.0 → 53.7 MiB |

Single-process RSS is the maximum observed for either a Hook or the parser
worker; it is not their combined memory. The candidate introduces a persistent
worker, so it does not promise lower combined idle memory for a 1 MiB session.
Candidate cold parsing reads approximately 1.001 MiB at every history size;
unchanged polls read zero body bytes. A small appended Turn reads 1,052–1,056
bytes, including cursor fingerprints. The largest measured collector cycle was
7.04 ms. Hook transcript-body reads and retry spawns are both zero.

The evolving case uses 8 MiB of prior history, one user request, three tools,
eight notifications and a late `last-prompt`. No lock is artificially held.

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Detached retry children | 8 | 0 |
| Sampled peak aggregate RSS, including collector | 425.5 MiB | 94.2 MiB |
| Transcript bytes read across Hook/retry/parser processes | 134,325,514 | 1,055,139 |
| User Turns / LLM requests / LLM responses | 1 / 4 / 4 | 1 / 4 / 4 |
| Tool calls / results | 3 / 3 | 3 / 3 |

Aggregate RSS is sampled every 50 ms and may miss short peaks. Safety guards
limit aggregate RSS to 1,536 MiB, Node old space to 256 MiB, and retry creation to
64 children / three generations. No safety guard was reached. An additional
128 MiB sparse-file test forbids both transcript reads and child spawning in the
Hook path; it passes for both products.

## Correctness and native validation

- The native reader suite covers queued Turns, late third-party prompt progress,
  incomplete/unterminated JSON lines, late output, restart/staged replay, legacy
  cursor migration, out-of-order legacy anchors, source replacement during a
  read, in-place rewrites, capacity/I/O failures and more than 1,024 sources.
- Four Input/normalization/masking/token/Span integration variants cover Qoder
  and QoderCN, IDE and CLI. Each retains three Turns, three tool pairs and six
  LLM calls through duplicate notifications and restart; exact usage remains
  750 input / 75 output tokens. Tool arguments retain JSON object types.
- Native GUI validation used authenticated Qoder IDE 1.37.0 and QoderCN IDE
  1.37.0, packaged Hook assets, isolated candidate Inputs/StateStore/shared
  flushers, and a localhost protobuf OTLP receiver. The final scoped window has
  two Turns, four LLM calls, four tool pairs (including two observed failures),
  20 events, no duplicate event IDs and 16 received Spans. Strict event validation
  reports zero required-field, type, pairing, boundary or duplicate errors.
- Independent Span validation reports internal semantic and capability checks
  PASS, with 4/4 LLM token/message coverage and matching AGENT usage aggregation.
  Its overall verdict is **INCOMPLETE**: the existing beta.13 converter assigns
  ENTRY an external synthetic parent `0000000000000001`. The same behavior was
  reproduced from baseline Hook events and the unchanged converter. Complete
  mode therefore fails `input.missing_parent_evidence`; fragment mode retains
  that warning and the recommended-metadata warnings instead of hiding them.
- Final asset hashes match the tested package/deployment. Restarting that build
  adds no output bytes. Original shared Hook settings and file modes were
  restored, private configuration backups removed, and both IDEs returned to
  their prior workspaces.

Typecheck and build pass. The full Node 22 suite reports 6,332 passed, 70 skipped
and two failures in the existing Claude configuration-lock concurrency test and
its deployment-isolation wrapper. Both matching failures also occur in an
export of the unmodified baseline; the Qoder suites pass. The baseline export
also has separate Git-dependent harness gaps, so it is not presented as a clean
full-suite baseline run.

Windows, a complete system-service installer upgrade/rollback, cloud readback,
and the reported customer's OS/cloud-shell combination were not tested. These
results establish local resource and collection behavior, not the cause of a
customer watchdog reset or end-to-end exactly-once delivery.
