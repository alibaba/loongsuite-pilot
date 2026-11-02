# Explicit host plugin contracts

This independent developer workspace calls the real public Pilot Input, InputManager,
normalizer and Flusher APIs, and the retained agent-side Node/Python plugins. It is
not included by the product workspace or packaging. No host runtime is a product
Cargo feature or dependency. No test is silently skipped.

Run explicitly with Rust 1.99.1, GLIBC 2.34, Node 22 and Python 3 available in the
isolated runner; use synthetic HOME/USERPROFILE/XDG directories and network disabled:

```sh
cargo test --offline --locked --manifest-path tests/host-plugin-contracts/Cargo.toml -- --nocapture
```

The runner must expose host executables read-only. All plugin data, checkpoints,
configuration and JSONL files use temporary directories. Exporters capture spans in
memory. No service, user profile or live SLS endpoint is used.

Coverage includes real Hermes Python and OpenCode/OpenClaw Node plugin callbacks,
public Native collectors, InputManager identity/upstream linking, final JSONL and
native GenAI span conversion. OpenClaw split-poll tests keep one Node process alive
and use atomic temporary-file handshakes before each Native poll; no copied log
snapshots stand in for a live append. The SSE fixture executes the existing test
helper after replacing only its Vitest mocking adapter in the isolated Node host.
The helper retains its original stream data, 50ms fake clock and ordering.

The product's locked dependency versions and both vendored Boa patches are reused.
After product dependency graph additions, synchronize this development lock from
the product lock plus this package block; avoid a full generate-lockfile re-resolve.

The repository runner is explicit and validates its GLIBC image. Point
PILOT_TEST_HOST_NODE_BIN at a Node22+ bin directory compatible with that image,
then run bash scripts/testing/verify-host-plugins-glibc234.sh. The directory
is mounted read-only; the installed host executable is never modified.
