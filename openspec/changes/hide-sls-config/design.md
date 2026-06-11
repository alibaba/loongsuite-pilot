## Context

Loongsuite Pilot currently resolves SLS upload configuration in `src/core/config-loader.ts`. Destination fields (`endpoint`, `project`, `logstore`) can come from environment variables or from `~/.loongsuite-pilot/config.json`, and the installer writes default destination values into that config file during setup. This makes internal telemetry routing visible to users and couples install-time config generation to runtime reporting behavior.

The desired model is that Loongsuite Pilot owns its default SLS destination as package code. User config remains available for local operational preferences, but the default telemetry destination is no longer a public configuration surface. Existing installations can keep legacy `sls` fields on disk without migration, but those fields must not affect the packaged runtime.

## Goals / Non-Goals

**Goals:**

- Move the default SLS endpoint, project, and logstore into a TypeScript module that is bundled with the application.
- Make runtime SLS destination resolution prefer the internal code-owned destination for normal packaged behavior.
- Stop installer scripts from writing default SLS destination fields into `config.json`.
- Preserve existing config files and avoid destructive cleanup during install or startup.
- Keep implementation compatible with a later packaging step that obfuscates bundled constants.

**Non-Goals:**

- This change does not implement the actual production bundle obfuscation pipeline.
- This change does not encrypt the SLS destination at runtime or claim strong secret protection against a determined reverse engineer.
- This change does not remove unrelated user config fields such as `dataDir`, `userId`, listener settings, retention, JSONL output, or agent content policy.
- This change does not redesign SLS upload protocol behavior in `SlsFlusher`.

## Decisions

1. Add an internal SLS destination module under `src`.

   The module will export the built-in SLS mode and destination values used by `buildSlsConfig()`. Keeping these values outside `config-loader.ts` makes ownership explicit, gives packaging a narrow target for future obfuscation, and avoids spreading constants across installer scripts, docs, and tests.

   Alternative considered: leave constants in installer scripts and simply stop documenting them. This still writes values into user-visible config and does not satisfy the goal.

2. Treat legacy `config.json` destination fields as inert by default.

   `buildSlsConfig()` will no longer read `file.sls.endpoint`, `file.sls.project`, or `file.sls.logstore` when constructing the default SLS destination. Existing installed users may keep those fields in `config.json`, but runtime behavior will use the internal destination instead.

   Alternative considered: use config file values as fallback only when internal values are missing. This creates surprising legacy behavior and weakens the guarantee that old visible values no longer matter.

3. Preserve explicit operational controls separately from destination ownership.

   User-visible controls that do not expose internal routing, such as `sls.enabled`, `batchMaxSize`, and `flushIntervalMs`, can continue to be read from `config.json`. Environment overrides for development and CI can remain supported if they are documented as developer/operator controls, but packaged end-user installs should not rely on them.

   Alternative considered: remove all `sls` config support. This would be a larger behavioral break and would remove useful local controls that are not part of the sensitive destination.

4. Update installer scripts to stop writing default SLS destination fields.

   The installer should no longer populate `sls.endpoint`, `sls.project`, or `sls.logstore` for normal installs. It should preserve an existing `sls` object if present, only touching non-destination settings that remain intentionally configurable.

   Alternative considered: delete legacy SLS fields during install. This is more invasive, risks user confusion, and is unnecessary because runtime ignores them.

5. Keep environment and installer override paths active for operator use.

   `LOONGSUITE_SLS_ENDPOINT`, `LOONGSUITE_SLS_PROJECT`, and `LOONGSUITE_SLS_LOGSTORE` environment variables will continue to override the built-in destination. Installer CLI flags such as `--sls-endpoint`, `--sls-project`, and `--sls-logstore` will also be retained for internal/operator installs, but normal installs will not write the default internal destination into user-visible config unless those flags are explicitly supplied.

   Alternative considered: remove all destination override paths. This would better hide internals but would make internal testing and controlled deployments harder.

6. Treat obfuscation as an optional release packaging extension.

   The current `npm run build` uses `tsc`, which emits readable JavaScript files and does not hide string constants. This change will place the internal destination in a clear module boundary; production obfuscation requires adding a bundle/obfuscation build step and validating the generated release artifact.

## Risks / Trade-offs

- Legacy deployments that intentionally used `config.json` to point SLS at a custom destination will silently stop doing so. Mitigation: document the behavior change in release notes and preserve explicit developer/operator environment overrides if custom routing is still required for internal testing.
- Internal destination constants in TypeScript are still visible in unobfuscated `tsc` build output. Mitigation: add a release packaging step that bundles/minifies/obfuscates the runtime entrypoint before publishing.
- Installer scripts may diverge if only one deployment script is updated. Mitigation: update both `deploy/installer.sh` and `deploy/installer-inner.sh` together and add script-level review coverage.
- Tests that assert config-file precedence will need to change. Mitigation: update config-loader tests to assert legacy destination fields are ignored while non-destination SLS settings still apply.

## Migration Plan

1. Add the internal SLS destination module and update `buildSlsConfig()` to use it.
2. Update unit tests to cover internal defaults, ignored legacy config destination fields, disabled SLS behavior, batching settings, and active environment override behavior.
3. Remove installer writes for default SLS destination fields while preserving existing config files.
4. Update README/sample config content so users do not see internal SLS destination fields as normal configuration.
5. Release without rewriting existing `config.json`; rollback can restore the previous config-loader precedence and installer writes if necessary.
6. If obfuscation is included in this implementation, add a production build script that bundles `dist/index.js` or the TypeScript entrypoint and applies string/control-flow obfuscation only to release artifacts, not to source.

## Open Questions

- Should packaging obfuscation be included in this same change, or delivered as a separate release hardening change after the config behavior is verified?
