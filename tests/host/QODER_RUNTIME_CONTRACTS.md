# Explicit Qoder host-runtime contracts

Run npm run test:host:qoder-runtime with Node22+, Bash/POSIX utilities, synthetic
HOME/USERPROFILE/XDG paths, and no network. The three original suites are unchanged.
They execute the retained CLI shell wrapper, Node token preload, and Work-family
forwarding compatibility asset using temporary host executables and real child
processes. They do not invoke a copied legacy collector implementation.

This optional developer command is not a product dependency or default Cargo test.
The forwarding compatibility asset is still packaged; this coverage does not
reactivate the retired managed Work Node overrides. Linux execution is recorded
separately from the cross-platform path shapes and other platform applicability.
