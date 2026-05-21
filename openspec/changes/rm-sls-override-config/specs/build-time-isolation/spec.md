## ADDED Requirements

### Requirement: Compile-time build constant __INTERNAL_BUILD__

The build system SHALL define a global compile-time constant `__INTERNAL_BUILD__` of type `boolean`. The constant SHALL be replaced with a literal `true` or `false` at build time by esbuild's `define` option.

A TypeScript ambient declaration file SHALL declare `__INTERNAL_BUILD__` so that source code can reference it without type errors.

#### Scenario: Internal build sets constant to true
- **WHEN** the build is invoked with `node build.mjs --internal`
- **THEN** every occurrence of `__INTERNAL_BUILD__` in the compiled output SHALL be replaced with the literal `true`

#### Scenario: External build sets constant to false
- **WHEN** the build is invoked with `node build.mjs` (without `--internal`)
- **THEN** every occurrence of `__INTERNAL_BUILD__` in the compiled output SHALL be replaced with the literal `false`

### Requirement: Dead-code elimination removes unreachable branches

esbuild SHALL eliminate code branches guarded by `if (false) { ... }` (after define replacement) from the compiled output. This ensures that code paths exclusive to the internal build do not appear in external build artifacts.

#### Scenario: External build excludes internal-only code
- **WHEN** source contains `if (__INTERNAL_BUILD__) { buildInternalSlsEndpoint(); }`
- **AND** the build is invoked without `--internal`
- **THEN** the compiled output SHALL NOT contain the `buildInternalSlsEndpoint()` call or the surrounding `if` block

#### Scenario: Internal build preserves internal-only code
- **WHEN** source contains `if (__INTERNAL_BUILD__) { buildInternalSlsEndpoint(); }`
- **AND** the build is invoked with `--internal`
- **THEN** the compiled output SHALL contain the `buildInternalSlsEndpoint()` call (the `if (true)` wrapper may be removed but the body SHALL remain)

### Requirement: Two build targets in package.json

The project SHALL provide two named build scripts: `build:internal` and `build:external`. The default `build` script SHALL produce the internal build.

#### Scenario: Default build produces internal variant
- **WHEN** a developer or CI runs `npm run build`
- **THEN** the output in `dist/` SHALL be the internal build (equivalent to `build:internal`)

#### Scenario: External build produces external variant
- **WHEN** a developer or CI runs `npm run build:external`
- **THEN** the output in `dist/` SHALL be the external build with `__INTERNAL_BUILD__` set to `false`

### Requirement: esbuild output matches existing dist/ structure

esbuild SHALL output compiled JavaScript files to `dist/` with the same directory structure as the current `tsc` output (one `.js` file per `.ts` source file). The output format SHALL be ESM, targeting ES2022, matching the project's `tsconfig.json` configuration.

#### Scenario: Output preserves file-per-file structure
- **WHEN** the build is invoked (internal or external)
- **THEN** each `.ts` file in `src/` SHALL produce a corresponding `.js` file in `dist/` at the same relative path
- **AND** `dist/index.js` SHALL remain the main entry point
- **AND** `node dist/index.js` SHALL start the application without errors

### Requirement: Type checking remains available via tsc

The `typecheck` script SHALL run `tsc --noEmit` for full TypeScript type checking, independent of the esbuild build step. Type errors SHALL NOT be silently ignored because esbuild does not perform type checking.

#### Scenario: Type check catches errors that esbuild would miss
- **WHEN** a developer introduces a type error in source code
- **AND** runs `npm run typecheck`
- **THEN** the command SHALL exit with a non-zero status and report the type error

### Requirement: deploy/package.sh uses esbuild build

The packaging script `deploy/package.sh` SHALL invoke the esbuild-based build (via `npm run build` or equivalent) instead of `npx tsc`. The `--skip-build` flag SHALL continue to work as before.

#### Scenario: Package script builds with esbuild
- **WHEN** `bash deploy/package.sh` is invoked without `--skip-build`
- **THEN** it SHALL run the esbuild-based build command to produce `dist/`
- **AND** the resulting `dist/` SHALL be a valid internal build

#### Scenario: Package script supports external build
- **WHEN** `bash deploy/package.sh --external` is invoked
- **THEN** it SHALL run `npm run build:external` (or equivalent) to produce `dist/`
- **AND** the resulting `dist/` SHALL be a valid external build
