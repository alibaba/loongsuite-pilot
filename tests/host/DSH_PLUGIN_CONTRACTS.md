# DSH host plugin contracts

Run the unchanged four-declaration suite when working on the DSH host plugin:

    npm run test:host:dsh

This is an optional development check. The Rust collector does not need Node.
The DSH application loads the shipped assets/plugins/dsh/plugin.mjs in its own
host runtime; the plugin's shared resource-context module is also packaged.
agents.d/dsh.json still names that plugin source. Both assets remain in the actual
xtask runtime file list. These contracts protect the enable-marker at load time
and after disable/re-enable, as well as worker identity projection and token
exclusion. They are retained host contracts, not retired core-runtime behavior
and not Rust test passes. Real DSH application installation is not claimed here.

On 2026-11-03 the original source was byte-identical at ef8953 and dae1582.
All four original declarations ran unchanged with Node22.22.3 on Linux/glibc2.34:
4 passed, 0 failed, 0 skipped. Windows/macOS have not been run for this receipt.
