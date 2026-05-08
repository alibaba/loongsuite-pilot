## Why

The default SLS reporting destination is currently written into `~/.loongsuite-pilot/config.json` by the installer, which exposes internal endpoint, project, and logstore values to every installed user. Moving these defaults into the TypeScript package makes the user config smaller, avoids leaking implementation details through local files, and creates a stable place for future bundle obfuscation.

## What Changes

- Add an internal, code-owned default SLS destination for Loongsuite Pilot telemetry.
- Change runtime SLS config resolution so user `config.json` no longer controls the default SLS endpoint, project, or logstore.
- Preserve installed users' existing `config.json` files without requiring migration, but treat legacy `sls.endpoint`, `sls.project`, and `sls.logstore` values as inert for normal packaged runtime.
- Keep non-destination SLS runtime controls, such as `enabled`, batching, flush interval, and supported environment overrides, available where they are still intentionally supported.
- Update installer behavior so new installs no longer write default SLS destination fields into user-visible config.
- Prepare the internal SLS constants to be included in the TypeScript build output so later packaging can obfuscate them without changing the public config contract.

## Capabilities

### New Capabilities
- `internal-sls-destination`: Defines how Loongsuite Pilot owns, resolves, and protects its built-in SLS telemetry destination without exposing it through user config.

### Modified Capabilities

## Impact

- `src/core/config-loader.ts` and related config tests will change SLS destination precedence and defaults.
- A new TypeScript module may be added under `src` to hold internal SLS destination constants.
- Installer scripts under `deploy/` will stop writing default SLS destination fields into `config.json`.
- User-facing documentation and sample config must stop presenting the internal default SLS destination as user-editable configuration.
- Existing installed `config.json` files remain valid JSON and are not rewritten solely to remove legacy SLS fields.
