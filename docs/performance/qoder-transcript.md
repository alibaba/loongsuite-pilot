# Qoder / QoderCN bounded transcript collection

## Comparison target

Measured on 2026-10-31, macOS 26.3.2 / arm64 / 48 GiB, using the same
Node 22.22.2 for the original shell wrappers and the candidate parser worker.
Baseline: `f84e3881958b39c5c7cbe8a035f50ccd80a25783`. Production implementation:
`ff4072f97e91db5d4f4d40dc6800c6fa98bb4532` (including the resource hardening).

The architecture follows Codex's thin Hook and collector-owned processing
([#69](https://github.com/alibaba/loongsuite-pilot/pull/69)), incremental recovery
([#153](https://github.com/alibaba/loongsuite-pilot/pull/153)), and bounded cache
precedents ([#405](https://github.com/alibaba/loongsuite-pilot/pull/405),
[#431](https://github.com/alibaba/loongsuite-pilot/pull/431)). Qoder's native
message/tool boundaries and its existing token enrichment remain authoritative.
The file-type validation, capacity-before-publication and adversarial boundary
tests also draw on the resource-safety work in
[#532](https://github.com/alibaba/loongsuite-pilot/pull/532). This implementation
retains collector-owned incremental reads and zero detached retries.

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
| Qoder | 1 MiB | 71.1 → 63.5 ms | 58.4 → 51.3 ms | 60.1 → 53.6 MiB |
| Qoder | 8 MiB | 76.6 → 71.7 ms | 88.3 → 52.5 ms | 114.6 → 53.5 MiB |
| Qoder | 32 MiB | 158.2 → 84.0 ms | 102.9 → 52.9 ms | 277.0 → 53.5 MiB |
| QoderCN | 1 MiB | 70.4 → 64.6 ms | 55.6 → 50.5 ms | 60.3 → 53.5 MiB |
| QoderCN | 8 MiB | 76.3 → 71.6 ms | 62.8 → 52.4 ms | 114.5 → 53.6 MiB |
| QoderCN | 32 MiB | 149.1 → 83.0 ms | 104.8 → 55.4 ms | 274.2 → 53.6 MiB |

Single-process RSS is the maximum observed for either a Hook or the parser
worker; it is not their combined memory. The candidate introduces a persistent
worker, so it does not promise lower combined idle memory for a 1 MiB session.
Candidate cold parsing reads approximately 1.001 MiB at every history size;
unchanged polls read zero body bytes. A small appended Turn reads 1,052–1,056
bytes, including cursor fingerprints. The largest measured collector cycle was
4.45 ms across these runs. Hook transcript-body reads and retry spawns are both zero.

The evolving case uses 8 MiB of prior history, one user request, three tools,
eight notifications and a late `last-prompt`. No lock is artificially held.

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Detached retry children | 8 | 0 |
| Sampled peak aggregate RSS, including collector | 417.4 MiB | 96.3 MiB |
| Transcript bytes read across Hook/retry/parser processes | 134,325,514 | 1,055,139 |
| User Turns / LLM requests / LLM responses | 1 / 4 / 4 | 1 / 4 / 4 |
| Tool calls / results | 3 / 3 | 3 / 3 |

The scale table is from the full resource-hardening run; the aggregate row is
from a separate same-input natural-case rerun with identical production assets.
That rerun registers wrapper PIDs immediately at spawn, before Node preload, and
samples every 50 ms with at most one asynchronous `ps` in flight. This reduces
missed short Hooks without introducing synchronous sampling stalls. Sampling
still may miss short peaks; the aggregate row is not a hard RSS bound. Safety guards
limit aggregate RSS to 1,536 MiB, Node old space to 256 MiB, and retry creation to
64 children / three generations. No safety guard was reached. An additional
128 MiB sparse-file test forbids both transcript reads and child spawning in the
Hook path; it passes for both products.

## Correctness and native validation

- A four-process last-slot race admits exactly one additional notice at the
  128-context cap. Publication and ACK share a short metadata gate; ACK also
  checks the file generation, preserving new same-watermark observations.
- A real Unix FIFO swapped in after path stat is rejected without stranding
  the Input, with cursor retention and successful repair. Valid histories over
  32 MiB retain a small current Turn, UTF-8 crossing 64 KiB chunks is preserved,
  and dense-object/capacity failures recover without false acknowledgement.
- The native reader suite covers queued Turns, late third-party prompt progress,
  incomplete/unterminated JSON lines, late output, restart/staged replay, legacy
  cursor migration, out-of-order legacy anchors, source replacement during a
  read, in-place rewrites, capacity/I/O failures and more than 1,024 sources.
- Four Input/normalization/masking/token/Span integration variants cover Qoder
  and QoderCN, IDE and CLI. Each retains three Turns, three tool pairs and six
  LLM calls through duplicate notifications and restart; exact usage remains
  750 input / 75 output tokens. Tool arguments retain JSON object types.
- The earlier native GUI validation used authenticated Qoder IDE 1.37.0 and QoderCN IDE
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
- That GUI run preceded the resource hardening; its production assets match
  the initial implementation in `98307f5b`. The follow-up package's asset hashes
  match `ff4072f9`, and resuming three fully committed real native files adds no
  events or OTLP batches. One incomplete earlier probe was excluded from this
  resume check and left untouched. No new GUI request was made for this follow-up.
  Original shared Hook settings/file modes and prior IDE workspaces remain
  restored; the resume check changes no shared Hook configuration.

Typecheck and build pass. The expanded Qoder regression has 198 passing tests.
The full Node 22 suite reports 6,342 passed, 70 skipped
and two failures in the existing Claude configuration-lock concurrency test and
its deployment-isolation wrapper. Both matching failures also occur in an
export of the unmodified baseline; the Qoder suites pass. The baseline export
also has separate Git-dependent harness gaps, so it is not presented as a clean
full-suite baseline run.

The adjacent legacy-retry fixture explicitly waits for both Hook observations
before letting its test collector drain; process startup order is not used as
an observation-time guarantee. First-discovery history policy is unchanged.
Trusted Gitleaks v8.30.1 passes the entire rewritten PR range: the artificial
masking string is constructed at runtime, without changing scanner rules or
adding an allowlist.

Windows, a complete system-service installer upgrade/rollback, cloud readback,
and the reported customer's OS/cloud-shell combination were not tested. These
results establish local resource and collection behavior, not the cause of a
customer watchdog reset or end-to-end exactly-once delivery.
