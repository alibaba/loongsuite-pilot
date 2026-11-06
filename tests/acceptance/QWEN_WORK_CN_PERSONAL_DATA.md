# QwenWorkCN personal-data acceptance

These three developer tests replace the old tests that silently selected the local
Mac QwenWorkCN database or latest personal transcript. They are registered with
explicit ignore reasons and are **not** evidence that real personal data was tested.

Provide an authorized, sanitized **consistent exported SQLite snapshot** (no live
WAL/journal sidecars), or a sanitized JSONL transcript containing user and assistant
rows. Paths must be explicit absolute files. No HOME search or default path is used.
The tests copy the file into a private temporary directory, use read-only SQLite
queries, and isolate HOME, output and checkpoints. They create no network flusher,
contact no default SLS destination, and never advance personal source progress.

Run either database test with:

    PILOT_QWEN_ACCEPTANCE_DB=/absolute/path/agents-snapshot.db \
      cargo test --all-features --locked --test qwen_personal_data_acceptance \
      qwen_db_ -- --ignored

Run the transcript test with:

    PILOT_QWEN_ACCEPTANCE_TRANSCRIPT=/absolute/path/sanitized-session.jsonl \
      cargo test --all-features --locked --test qwen_personal_data_acceptance \
      qwen_transcript_ -- --ignored

Explicit execution with missing paths fails. The tests retain canonical field,
request delta, old/new collector equivalence and dedicated native hook assertions.
The original installed wrapper binding is exercised separately by the normal
hook_entry_history tests. Failure messages withhold transcript bodies and accounts.
The 30-second native hook budget is retained; SQLite callback collection is bounded
at ten seconds. These are acceptance harness bounds, not weakened production budgets.

Normal CI reports these as **three additional manual-data acceptance tests ignored**.
Existing synthetic native tests demonstrate behavior independently; their results
cannot be reported as real-snapshot acceptance. Until the above commands have been
run against authorized real snapshots, real-data acceptance remains pending.
