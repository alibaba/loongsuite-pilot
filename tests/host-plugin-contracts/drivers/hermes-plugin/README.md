# Hermes host input provenance

These 38 synthetic input JSON documents come from the exact fixture builders in
`tests/unit/hooks/hermes-agent-plugin.test.mjs` at ef8953, f84e388 and main 2b24a8b
(all byte-identical; SHA256 17558916b417e97267c514775ac80bae87176f38566b1bdad345d6df924b7dbd).
The original 26 declarations expand to 37 test variants; Responses API has two
separate replay inputs. Inputs contain only events/options, never product outputs
used as expected values. All original 37 Node tests passed during extraction.

`replay.py` is the unchanged embedded synthetic Python host driver from that source.
The real retained Hermes plugin is dynamically imported at runtime. Rust tests
independently retain the original expected fields and assertions, then replay each
actual JSONL through public HermesLogInput and compare canonical/typed/resource
fields. Rust prepares the two original beforeSpawn filesystem fixtures explicitly;
the captured beforeSpawn text is provenance, never evaluated.

The generator is temporary provenance tooling outside the deliverable. Running the
Rust tests does not require Vitest, original Node tests or a fixture generator.
