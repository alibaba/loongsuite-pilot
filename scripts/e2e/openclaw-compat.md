# Installed OpenClaw Gateway acceptance

This harness uses a **real LLM provider**, Gateway RPC, the release packaging script,
the public installer, and the installed collector. It never uses `agent --local`
or a mock model. Run it only in a fresh, disposable Linux container. It refuses to
run on a host or against an existing OpenClaw/Pilot configuration.

## Build an exact candidate

Build from a clean checkout of the exact commit or PR merge result being accepted.
Keep the Git SHA, image ID/digest and `result.json` package hash in the report. Do
not send credentials in build arguments, the build context or image layers.

```sh
docker build -f scripts/e2e/openclaw-compat.Dockerfile \
  --build-arg OPENCLAW_VERSION=2026.3.8 -t pilot-openclaw-compat:3.8 .
# Modern regression uses the same Pilot candidate, with OPENCLAW_VERSION=2026.6.10.
```

Pin the Node base image by digest in a release acceptance environment. Exclude
host `node_modules`, `.git`, evidence and secrets from the Docker build context.
The adjacent `openclaw-compat.Dockerfile.dockerignore` provides these exclusions
for Docker BuildKit; use an equivalent explicit `--ignorefile` with Podman.
The root `.dockerignore` also protects classic Docker contexts. The Dockerfile
copies only the required source directories; credentials must still stay outside
the checkout, regardless of builder or ignore-file support.

## Supply credentials at runtime

Prepare a mode-0600 JSON secret **outside the checkout** using an authorized
provider and its actual model ID:

```json
{
  "provider": "deepseek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "apiKey": "<runtime-secret>",
  "api": "openai-completions"
}
```

The default output is an isolated local OTLP receiver, not a production service.
To verify an authorized CMS/ARMS destination, mount a second secret with
`{"cms":{"endpoint":"<HTTPS OTLP endpoint>","licenseKey":"<secret>","workspace":"<workspace>"}}`
and set `OPENCLAW_E2E_CMS_FILE` to its container path. Never archive that file or
OpenClaw's generated `models.json`: it may contain materialized credentials.

```sh
docker run --init --name pilot-openclaw-acceptance \
  --mount type=bind,src=/absolute/private/provider.json,dst=/run/provider.json,readonly \
  -e OPENCLAW_E2E_PROVIDER_FILE=/run/provider.json \
  -e OPENCLAW_E2E_RUN_ID=oc38-unique-run \
  -e OPENCLAW_E2E_SERVICE=pilot-openclaw-acceptance-unique-run \
  pilot-openclaw-compat:3.8
docker cp pilot-openclaw-acceptance:/evidence/oc38-unique-run ./oc38-unique-run
docker rm pilot-openclaw-acceptance
```

Podman can run the same image; prefer `podman secret create` and `--secret` over
bind-mounting credentials. Remove only run-scoped containers/secrets afterwards;
do not prune unrelated workloads. Evidence includes synthetic prompts, model
responses and logs and should remain private; commit only sanitized summaries.

`OPENCLAW_CLI_PATH` binds the actual absolute Gateway entry (the Dockerfile sets
it to the installed npm entry). Gateway runs as `node openclaw.mjs gateway
--allow-unconfigured --bind loopback --port 18789` from the entry directory;
loopback isolates the test, while native token authentication stays enabled.
`OPENCLAW_E2E_INSTALL` identifies the actual package installation.
`OPENCLAW_E2E_PATH_INSTALL` optionally selects a different installation for PATH,
to verify that neither the installer nor the restarted collector uses its version.
For the customer layout, expose the actual package at `/app` and set
`OPENCLAW_CLI_PATH=/app/openclaw.mjs`. The exact
`OPENCLAW_E2E_VERSION` is only asserted by the test: Pilot receives no version
override and must discover the package metadata itself. `OPENCLAW_E2E_DISPOSABLE=1`
is a safety opt-in, not permission to run against an existing installation.

## Gates

| Gate | Evidence |
| --- | --- |
| Bound-entry install | Version-compatible config despite a different PATH candidate; real `openclaw config validate`; unrelated settings retained |
| Gateway traffic | One text turn, a two-read-tool turn, a post-restart turn, a content-off turn |
| Source fidelity | Every native assistant response collected once; positive input/output/cache token parity |
| Trace semantics | One ENTRY/AGENT per turn; STEP → LLM/TOOL; paired tool IDs; positive nested times; exact service/worker |
| Canonical schema | Repository strict JSONL validator, including system-instruction text-part arrays |
| Recovery | Gateway and collector restart keep the session and do not replay historical responses |
| Privacy | Marker and content-field absence in raw plugin events, canonical events and converted spans, including a missing-file result |
| Lifecycle | Watchdog restores a removed load path and repairs version-specific hooks; reinstall is idempotent; uninstall preserves unrelated config |

`openclaw-assertions.mjs` is a self-contained **scenario-specific** validator with
positive and negative unit tests. It does not require the untracked
`docs/trace-validation-rules.json`, and is not a claim of full ARMS semantic-rule
coverage. CMS configuration and zero persisted export failures alone do **not**
prove ingestion: independently read back every reported trace and compare span
IDs, topology, service, worker, token totals and content-off fields. A local-only
receiver PASS must be labelled local-only.

After independently querying SLS for the exact `result.json` service and time
window, run `node scripts/e2e/openclaw-backend.mjs <evidence-directory> <SLS-JSONL>`.
It fails on missing/duplicate spans, changed identities/timestamps/tokens and
privacy violations; it writes a separate `backend-validation.json` on success.
Readiness uses the native loopback `/readyz` endpoint. This does not create a
read-only CLI device before the first real agent RPC requests its write scope.
Gateway token authentication and native device pairing remain enabled.

## Scope and known limitations

- OpenClaw 2026.3.8 native sender extraction is out of scope; configured identity
  and `AGENTTEAMS_WORKER_NAME` remain usable. Worker environment changes require
  restarting Gateway so the plugin reloads its resource attributes.
- A new standalone `--session-id` without a native session-store binding remains
  unsupported for legacy per-call correlation; this acceptance targets Gateway.
- Zero-token native provider records are not repaired or fabricated. Choose a
  provider returning actual per-call usage; an empty/zero usage test fails.
- 3.8 model timing is inferred and marked; no precise transport timing/TTFT is
  invented. A missing-file tool result is not a claim of every error/cancel path.
- This Linux acceptance does not certify Windows, customer EDR, every intermediate
  OpenClaw release, live version switching, or all concurrency/cancellation paths.
  Keep the existing unit/contract tests and CI checks as separate evidence.
