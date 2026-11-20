import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installer = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');

function hookDeploymentBlock() {
  const start = installer.indexOf('msg "==> 部署 hook 脚本..."');
  const end = installer.indexOf('    echo ""', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return installer.slice(start, end);
}

describe('public installer postinstall path', () => {
  it('deploys hooks from the installed package regardless of the caller cwd', () => {
    const block = hookDeploymentBlock();

    expect(block).toContain('[ -f "$PERMANENT_DIR/scripts/postinstall.js" ]');
    expect(block).toContain('"$NODE_BIN" "$PERMANENT_DIR/scripts/postinstall.js"');
    expect(block).not.toContain('[ -f scripts/postinstall.js ]');
    expect(block).not.toContain('"$NODE_BIN" scripts/postinstall.js');
  });

  it('warns without reporting success when postinstall is missing', () => {
    const block = hookDeploymentBlock();
    const invocation = block.indexOf('"$NODE_BIN" "$PERMANENT_DIR/scripts/postinstall.js"');
    const success = block.indexOf('msg "    ✅ Hook 脚本已部署"');
    const elseBranch = block.indexOf('\n    else\n');
    const warning = block.indexOf('msg "    ⚠️ postinstall.js 未找到，跳过 Hook 部署"');

    expect(invocation).toBeGreaterThanOrEqual(0);
    expect(success).toBeGreaterThan(invocation);
    expect(elseBranch).toBeGreaterThan(success);
    expect(warning).toBeGreaterThan(elseBranch);
  });
});
