# Public Pilot performance history

This is a Linux/Docker end-to-end collection method. It exercises the complete
public Pilot process: the Rust CLI loads its real adjacent SDK dynamic library;
JS versions execute the CLI declared by their published package. Both collect
raw synthetic Qoder native transcripts, source descriptors, event notices and
raw token sidecars through the actual input and JSONL flusher. No real Agent,
account, private recording, private endpoint or commercial helper is required.

Historical JS packages using Hook-produced history run their original packaged
Qoder Stop script for each raw turn. Capability selection reads the packaged
Qoder processor and collector bundle. Its script, processor and dependencies
run inside the measured container, with every required Hook process included
in cumulative CPU and RSS. The external source generator publishes raw input
and queues Stop triggers at the same fixed rate. An external bounded dispatcher preserves
all triggers, serializes calls for each transcript and reports child failures.

The fixture comes from the public Qoder transcript history tests and public
`hook-wakeup.mjs`/`qoder_wakeup.rs` publisher protocol. Its independent expected
identities require two requests, two responses, one tool call and one tool
result per turn, including exact token enrichment and required fields.

## Historical 100 ms method

`tests/performance_native/pilot-history-method.json` defines the method ID.
The original method uses 64 native sessions and 100 ms collection polling. Current Qoder and Codex settings are described below. Each of idle
(0 turns/s), low (10 turns/s, 低负载) and high (200 turns/s) runs for a 30-second
input interval, three repeats, with a 2-CPU/1-GiB container. Warmup and drain are
separate. The raw source producer is outside the measured container. Historical Hook
processing runs inside that container and uses the same 15-second drain
window. Fixed-rate input, event cardinality, tokens and field checks also apply
to these releases.

At high load a healthy run that produces all 6,000 turns can publish its measured
CPU and RSS after the drain expires if queued work remains and delivered events
form an intact prefix for each source. The report marks the affected high-load
point as 超出承载能力 and records the affected rounds, completed turns, missing
responses and backlog. The prefix check validates every attributable event and
requires complete event sets for warmup and delivered terminal responses.

CPU uses cumulative Docker accounting at interval boundaries and the actual
elapsed interval. One CPU is 100%. Resource samples retain the actual interval,
active CPU seconds and CPU through drain. RSS is the maximum sampled sum of
owned processes' `VmRSS`, sampled at 100 ms; shared pages may be counted more
than once. Cgroup memory/page cache is retained separately, never called RSS.
Both cgroup v1 and v2 are supported and the observed version enters the
environment identity. Missing accounting is an infrastructure error.

Latency is publication-to-first-observed-JSONL p95 for the final response,
including observer cadence. Cardinality, duplicate IDs, required fields and
exact tokens are hard checks. Idle and low load require full delivery. High load
requires three actual resource samples across three rounds. A capacity result
reports the missing responses and omits the aggregate latency.

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

One backfill invocation selects one unmeasured release, newest first. An accepted
high-load capacity result counts as measured and lets backfill continue. The
first confirmed native-contract incompatibility may exclude that version and older
ones only with reviewed public-source plus actual smoke evidence. Missing
assets, network failures, builds, OOM, bad config or unknown failures do not
advance that boundary. Resume pending infrastructure failures explicitly.

The chart's resource-value delta uses the preceding node containing valid data
and a positive previous value. This is arithmetic on the displayed values,
including previews; it does not establish a hardware-controlled causal result.
Old remote measurements must not be relabelled as this new method or subjected
to an absolute cross-hardware 50%-of-JS gate.

Workflow and publisher code live in source; generated history/HTML live on a
separate results branch and Pages. The root is the project homepage. The report
lives at `/performance/` with a relative copy of `history.json`. Raw samples,
fixtures and logs are Actions
artifacts. The write job uses trusted workflow code and validates compact data;
candidate execution receives no write credentials. Fork/PR runs do not publish.
No generated result is committed to the source PR or main branch.

The results branch also contains the trusted `performance-site.yml` workflow,
copied by the publisher from its own source checkout. This independent workflow
deploys the exact results commit on push or explicit dispatch, without building
or measuring Pilot. The measurement workflow only dispatches it after publication;
this is necessary because a GITHUB_TOKEN push does not start another push workflow.
Old site reruns skip when their data commit is no longer current. Initial setup
requires a maintainer push that seeds this workflow on the results branch and
permits that branch in the github-pages environment. Verify registration and the
first run before enabling routine dispatch; a missing workflow/API failure must
remain visible and does not mean a site was deployed.

An optional `temporary_preview` in results history contains only numeric
overrides for `v1.15.2` and `dev`. These values are projected onto the existing
release/main/dev nodes without changing their stored status. Each override stops
displaying once that same node has passed CI; other overrides remain independent.
It never creates formal nodes or changes backfill selection, quality gates or
compatibility boundaries. The charts initially scroll to the latest nodes.

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

All 33 protocol-helper/publication unit checks passed in an isolated remote directory, including bounded gate contention, rollback release, one-time native/token writes and trusted site-workflow copying. GitHub runs for public v1.16.0, v1.15.2 and the designated dev completed all nine rounds and publication after the fixture repair. The explicit polling canary remains separate. The short smoke's initial `metrics-summary.json`
is not a completed self-monitoring or token-summary acceptance result.

### Codex 性能

在 GitHub Actions 手动运行 Full Pilot performance history 时，选择
github-full-pilot-codex-rollout-v2。main 和 dev 测试选定的公开源码，release 测试官方发布包，
backfill 按发布版本从新到旧补测。JS 与 Rust 均使用原始 rollout 和正常 Stop 唤醒，
复用同一套事件与 token 校验。Codex 使用独立的版本序列，发布包最低为 v1.15.0。
更早的 JS 版本未将监听器轮询配置传给 Codex transcript 采集。

Qoder 和 Codex 均使用空闲与低负载 10 秒采集轮询、高负载 100 毫秒采集轮询。
三档各测三轮，每轮预热 64 个会话，随后采样 30 秒。资源采样间隔为 100 毫秒。
原始 transcript 与 Pilot 输出 JSONL 的每秒速率按 30 秒窗口内的实际字节数计算。
停压后的输出用于 15 秒排空验收。
高负载在 15 秒内交付不完时，已交付前缀仍须通过完整校验。若有未读源字节或
能证明截止后已交付，保留资源结果并标为超出承载能力。低负载缺失与任何数据错误
都会阻断测试。
