# Public Pilot performance history

This is a Linux/Docker end-to-end collection method. It exercises the complete
public Pilot process: the Rust CLI loads its real adjacent SDK dynamic library;
JS versions execute the CLI declared by their published package. Both collect
raw synthetic Qoder native transcripts, source descriptors, event notices and
raw token sidecars through the actual input and JSONL flusher. No real Agent,
account, private recording, private endpoint or commercial helper is required.

The fixture comes from the public Qoder transcript history tests and public
`hook-wakeup.mjs`/`qoder_wakeup.rs` publisher protocol. Its independent expected
identities require two requests, two responses, one tool call and one tool
result per turn, including exact token enrichment and required fields.

## Fixed method

`tests/performance_native/pilot-history-method.json` defines the method ID.
There are 64 native sessions and 100 ms collection polling. Each of idle
(0 turns/s), low (10 turns/s, 低负载) and high (200 turns/s) runs for a 30-second
input interval, three repeats, with a 2-CPU/1-GiB container. Warmup and drain are
separate. The producer is outside the measured container.

CPU uses cumulative Docker accounting at interval boundaries and the actual
elapsed interval. One CPU is 100%. Resource samples retain the actual interval,
active CPU seconds and CPU through drain. RSS is the maximum sampled sum of
owned processes' `VmRSS`, sampled at 100 ms; shared pages may be counted more
than once. Cgroup memory/page cache is retained separately, never called RSS.
Both cgroup v1 and v2 are supported and the observed version enters the
environment identity. Missing accounting is an infrastructure error.

Latency is publication-to-first-observed-JSONL p95 for the final response,
including observer cadence. It is not callback latency. Cardinality, loss,
duplicate IDs, fields and exact tokens are hard checks. A failed or partial
run never supplies invented zeros or claims three successful repeats.

## Preparation and commands

Run only on the authorized Linux benchmark machine or GitHub runner. Pull the
public Node image and prepare the selected package before timing. The fixture
and controller use Python standard-library modules only. No test framework or
real Qoder installation is needed.

`prepare_public.py --mode main|dev|release|backfill --repository OWNER/REPO
--ref REF --history HISTORY --history-repository alibaba/loongsuite-pilot
--output PREPARED` resolves exact public commits. Main/dev source runtime is
detected from that commit's root Cargo/package manifest. A release is downloaded
from the official public asset and checked against its published size and any
published SHA256. Older assets without a GitHub digest retain the actual
download SHA256 plus asset ID/name/size/URL with `checksum_source: download`;
this is never described as a GitHub-published checksum. A provided digest must
match. History selection resolves the current results-branch SHA through the
API before reading an immutable history URL, avoiding stale branch-CDN reads.
The result is `PREPARED/selection.json`:

- `complete: true`: no pending release, or an existing successful release.
- Otherwise: repository/ref/commit/kind/version/runtime. Prepared releases add
  package/entry/native_entry/asset_sha256/release_url, asset_id/asset_name/
  asset_size_bytes/asset_url/checksum_source.

Source Rust builds require the public locked dependency preparation and release
host plus `.so`; stage public runtime resources from the same commit. Source JS
builds use that commit's lockfile and public build command before staging.
Published JS archives contain `dist` and public resources but omit dependencies;
prepare their locked production dependencies before smoke/timing. Keep HOME and
Pilot data isolated during all preparation. Dependency, archive, layout, CLI,
dynamic-library and discovery errors are infrastructure failures.

`pilot_history.py --package DIR --image IMAGE --runtime rust|js --kind
main|dev|release --version VERSION --commit SHA --source-repository OWNER/REPO
--source-ref REF --output RESULTS` writes the compact `node.json` and raw round
evidence. Rust ELF host/SDK placement is resolved and the loaded SDK inode is
verified in the actual process maps; JS uses its package's declared CLI.

Add `--smoke-only` to run only the initial 64-source native contract check.
It writes `smoke.json` and never a report node. Exit 0 means
`classification: compatible, confirmed: true`; exit 1 is infrastructure or an
unconfirmed collection-contract failure. The receipt includes the fixture SHA.
Output timeout alone cannot establish historical incompatibility. This
controller intentionally never generates an automatic compatibility cutoff.

## Persistent nodes and history

The report contains stable releases in semver order, one mutable main and at
most one mutable dev. Repeated development runs replace dev; they never add
commit nodes. Main is measured at its exact merged commit. Clearing dev requires
proof that this exact development commit was merged. Stale runs cannot replace
newer main/dev results. Release history is measured once and retained.

One backfill invocation selects one unmeasured release, newest first. The first
confirmed native-contract incompatibility may exclude that version and older
ones only with reviewed public-source plus actual smoke evidence. Missing
assets, network failures, builds, OOM, bad config or unknown failures do not
advance that boundary. Resume pending infrastructure failures explicitly.

CPU/RSS deltas require adjacent complete, quality-passed nodes with the same
method and environment identities and a positive previous value. Hosted runner
hardware changes can make nodes incomparable. Old remote measurements must not
be relabelled as this new method or subjected to an absolute cross-hardware
50%-of-JS gate.

Workflow and publisher code live in source; generated history/HTML live on a
separate results branch and Pages. Raw samples, fixtures and logs are Actions
artifacts. The write job uses trusted workflow code and validates compact data;
candidate execution receives no write credentials. Fork/PR runs do not publish.
No generated result is committed to the source PR or main branch.

An optional `temporary_preview` in results history contains only four labelled
numeric rows for the six charts. It is displayed until the first passed node
for the current CI method exists. It never creates formal nodes or changes
backfill selection, quality gates or compatibility boundaries.

The single dev slot is bound by `history.json` on `sdk-performance-results`:
`configuration.dev_branch` names one branch in `alibaba/loongsuite-pilot`.
Other branches and PRs retain measurement artifacts but cannot replace this
public dev slot. The selector checks the binding before publication, and the
publisher rechecks the latest results commit on every CAS retry. A concurrent
binding change therefore rejects an old branch's in-flight result. Missing
binding fails closed for dev; main and releases remain independent. No repository
variable, PAT or additional secret is used for this authority.

To switch the displayed development branch, maintainers update that one JSON
field in a fresh results commit and clear the old dev node or replace it with a
pending node for the new branch's actual SHA. Never relabel old branch values as
new measurements. The page shows each node's recorded source and the current
binding. Each dev source/ref has independent workflow concurrency, so unrelated
branches cannot evict the designated branch's pending measurement.

## Verification status

The authorized remote functional smoke passed with the clean public
`48b87b407e225b80702269679931da284d988e57` full release package, Python3.6,
an existing Linux container image and cgroup v1. All 64 sources produced exactly
128 requests, 128 responses, 64 tool calls and 64 tool results, with required
fields, the `qoder-cli` label and exact 35/11 input/output tokens. The mapped SDK
matched the package manifest; all 104 resources matched their hashes. Clean
shutdown passed and the owned container was removed. This smoke produced no
performance report node or comparable CPU/RSS result.

All 27 protocol-helper/publication unit checks passed in an isolated remote directory, including designated-dev filtering, live binding changes and separate numeric-preview preservation; public JS1.15.2/1.16.0 smoke, effective 100-ms polling canary, cgroup-v2 execution and complete nine-round aggregation remain to be verified before routine publication. The short smoke's initial `metrics-summary.json`
is not a completed self-monitoring or token-summary acceptance result.
