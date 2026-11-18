These small native Go pprof fixtures were captured from the Multica v0.10.0
observability lab on 2026-11-17, under natural low load (including telemetry
polling). They are regression fixtures, not a reproduction of the historical
issue-changelog slowdown. No request bodies or model prompts are included.

- `cpu.pprof`: 30-second profile, 100 Hz, 17 samples / 170,000,000 ns CPU.
  SHA256 `04f259ca74be824ac6048321073460751a18e8127ef5c0fad55aed0725270d5e`.
- `allocs.pprof`: 10-second delta profile, 10,257,869 estimated allocated bytes.
  SHA256 `146cc18de2723828bbdc9c9c6d8ac54021c06631a9405fa27870328f5a9d6bd2`.

Expected totals were independently checked with Go's pprof tooling. The tests
also verify root-to-leaf frame ordering and the encoded Flamebearer invariants.
