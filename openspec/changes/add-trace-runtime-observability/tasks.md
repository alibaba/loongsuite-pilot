## 1. Simplify the implementation

- [x] 1.1 Restore Codex/Qoder/BaseInput, MetricsCollector identity and shutdown ordering to main; remove Observer and old detailed protocol.
- [x] 1.2 Reuse serialized byte sizes, keep scalar accounting on existing buffers, and bound cumulative Agent dimensions.
- [x] 1.3 Measure only synchronous converter calls; reuse L1 cycle and identity for internal snapshots.

## 2. Validate before delivery

- [x] 2.1 Add regression coverage for counter correctness, existing removal semantics, missing measurements, bounded dimensions and reporting isolation.
- [x] 2.2 Run focused/full tests, typecheck, build and strict specification validation; record any failures without treating them as passes.
- [x] 2.3 Compare baseline and modified real processing for output consistency, CPU, elapsed time and peak memory; record limits.
- [x] 2.4 Complete local offline replay and independent diff review; explicitly record the requester-waived installation E2E scope.
- [x] 2.5 Refresh remote state and prepare the update to existing PR #366, including removed functionality and verified scope; do not merge.

## Scope and verification

2026-09-04: User approved replacing the earlier detailed-attribution implementation with simple counters, and explicitly waived Docker installation testing. Public project documentation is unchanged. Previous validation results concern the superseded implementation.

Baseline: main `d725757470cfeb0028d813631771b8aa9d3f6bdd`, merged without conflicts. Node 22.22.2: focused 91 passed; final full suite 4,134 passed, 58 skipped, 24 failed. All 24 failure names match an independent, unmodified main source copy of the two Hermes test files; a probe confirms Python is terminated with SIGKILL. No related tests were changed or skipped. Typecheck, build and strict OpenSpec validation passed. Three independent reviews found no blocking issue.

Five-run real-chain offline comparison: event/Span counts and content/timing/local-topology digests match for three workloads; CPU median changes −0.66% to +0.66%, peak RSS median changes −1.64 to +1.80 MiB. Earlier three-run results varied up to +3.05% CPU and +5.20 MiB peak RSS. No zero-overhead, real-Agent, installed-Pilot or online-delivery claim is made.
