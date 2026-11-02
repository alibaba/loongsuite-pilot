# Native performance history contracts

Run the preserved PII benchmark with Cargo's optimized bench profile:

    cargo bench --offline --locked --bench pii_mask_history -- --test --nocapture

This executes the real Rust test harness and all twelve original workloads,
including five warmups, original 100/20/50 iterations, exact masking assertions,
and original 50/100 ms p95 limits. It has no ignored tests or relaxed debug limits.
The unoptimized debug profile is not a production latency comparison with V8 JIT.
The recipe reports real wall time, process CPU, throughput, and allocator live-byte
delta; the last metric describes native live allocations rather than a GC heap.

The source contract is fixed at ef8953de1b5d2aa6d719cb0409cb5f48f2b99b42
(tests/performance/pii-mask.perf.test.ts) and unchanged in main533.
