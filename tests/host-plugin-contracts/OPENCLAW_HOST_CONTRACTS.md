# Explicit OpenClaw Node host contracts

The unchanged Node suites exercise the actual retained OpenClaw plugin and optional
acceptance oracles. They do not enter default Cargo tests or product dependencies.
`legacy.test.mjs` SDK span assertions use the real Native GenAI converter through
`host_plugin_projection_bridge`; the OpenClaw JS adapter only restores the SDK's
read-only `spanContext()` method from the Native identity DTO.

Run with a genuine Node22 executable whose ELF interpreter matches the verification
image (including process.execPath child processes), synthetic HOME and no network:

```sh
cargo build --offline --locked --example host_plugin_projection_bridge
# Set to the actual absolute path in the current CARGO_TARGET_DIR.
export PILOT_NATIVE_PROJECTION_BRIDGE=/absolute/path/to/debug/examples/host_plugin_projection_bridge
export PILOT_MIGRATION_REPORT=target/openclaw-host-flow-report.json
npm run test:host:openclaw-flow -- --reporter=default
cargo test --offline --locked --manifest-path tests/host-plugin-contracts/Cargo.toml legacy_openclaw_real_input -- --nocapture
```

The separate Rust integration drives actual OpenClaw3.8 callbacks into its JSONL,
then public OpenClawPluginInput/InputManager/JsonlFlusher/OtlpTraceFlusher. Parallel
tools and both original clock-rollback variants preserve tokens, positive leaf
durations, parent containment, and raw/log/span session-key parity without Resource
contamination. It invokes the existing session-key oracle on these actual outputs.

These remain synthetic host callback/protocol contracts, not real Gateway/provider
E2E. The disposable-installation guard test explicitly sets the flag to0 and must
exit before any installation work. No service, real config or live SLS is touched.
