This fixture contains selected records from the official Kimi Code CLI 2.7.2 npm package, release source commit `56145f849caa305d42acd09b67fb65d11146f887`. The CLI ran two prompts in one isolated local session against a loopback Chat Completions server. The first prompt triggered a real Read on a synthetic file followed by a model reply. The second ran with `--continue`.

Project paths were replaced. Request context, tool schemas, startup metadata other than the wire format header, and diagnostic records were omitted. The timestamps, model and tool records, and native IDs came from the CLI.
