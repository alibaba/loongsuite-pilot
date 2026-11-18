/** Path → SHA-256 of each file under assets/hooks. The collector build fills this in. */
export const HOOK_ASSET_MANIFEST: Readonly<Record<string, string>> = {};

/** Path → SHA-256 of each built file under dist, except dist/index.js. The collector build fills this in. */
export const RUNTIME_ASSET_MANIFEST: Readonly<Record<string, string>> = {};
