import { buildSync } from 'esbuild';

export default function setup(): void {
  buildSync({ entryPoints: ['src/core/trace-context/runtime.ts'], outfile: 'assets/hooks/shared/trace-context.cjs',
    platform: 'node', target: 'es2022', format: 'cjs', bundle: true, mainFields: ['module', 'main'], minifySyntax: true });
}
