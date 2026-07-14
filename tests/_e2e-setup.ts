// Provide the build-time global that esbuild normally injects, so modules
// importing build-constants.ts can be loaded under vitest.
(globalThis as any).__PROPRIETARY_BUILD__ = false;
export {};
