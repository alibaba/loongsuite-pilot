declare const __PROPRIETARY_BUILD__: boolean;
// Source-level tools such as Vitest do not run the bundler that injects this flag.
// Fail closed there: internal-only features must stay disabled when the flag is absent.
export const PROPRIETARY_BUILD = typeof __PROPRIETARY_BUILD__ !== 'undefined' && __PROPRIETARY_BUILD__;
