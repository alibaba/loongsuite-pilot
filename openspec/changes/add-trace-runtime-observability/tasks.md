## 1. Simplify the implementation

- [x] 1.1 Restore Codex/Qoder/BaseInput, MetricsCollector identity and shutdown ordering to main; remove Observer and old detailed protocol.
- [x] 1.2 Reuse serialized byte sizes, keep scalar accounting on existing buffers, and bound cumulative Agent dimensions.
- [x] 1.3 Measure only synchronous converter calls; reuse L1 cycle and identity for internal snapshots.

## 2. Validate before delivery

- [x] 2.1 Add regression coverage for counter correctness, existing removal semantics, missing measurements, bounded dimensions and reporting isolation.
- [ ] 2.2 Run focused/full tests, typecheck, build and strict specification validation.
- [ ] 2.3 Compare baseline and modified real processing for output consistency, CPU, elapsed time and peak memory; record limits.
- [ ] 2.4 Run the available local E2E check and review the simplified diff; record any environment limitation explicitly.
- [ ] 2.5 Refresh remote state and update existing PR #366 without merging; describe removed functionality and verified scope.

## Scope

2026-09-04: User approved replacing the earlier detailed-attribution implementation with simple counters. Previous validation results refer to the old implementation and are not acceptance evidence for this revision. Public project documentation remains unchanged.

Local validation: build/typecheck and focused tests passed. First full suite: 4,129 passed, 58 skipped, 20 failed. One tracked-deletion scanner failure passed after staging removals; the other 19 stop when Python is terminated with SIGKILL and are being compared with main. User explicitly waived Docker installation testing on 2026-09-04; local tests and offline real-chain replay are authorized. No installed-agent or online-delivery claim is made.
