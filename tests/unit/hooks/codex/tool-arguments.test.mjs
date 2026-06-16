import { describe, expect, test } from 'vitest';

import {
  mergeCodexToolArguments,
  normalizeCodexToolArguments,
} from '../../../../assets/hooks/codex/tool-arguments.mjs';

describe('codex tool argument helpers', () => {
  test('apply_patch null input is not wrapped as command null', () => {
    expect(normalizeCodexToolArguments('apply_patch', null)).toBeNull();
    expect(mergeCodexToolArguments('apply_patch', null, 'apply_patch', null)).toBeNull();
    expect(mergeCodexToolArguments('apply_patch', undefined, 'apply_patch', null)).toBeUndefined();
  });

  test('single-source normalization keeps Bash command/workdir shape', () => {
    expect(normalizeCodexToolArguments('exec_command', {
      cmd: 'pwd',
      workdir: '/tmp/project',
      yield_time_ms: 1000,
    })).toEqual({
      command: 'pwd',
      workdir: '/tmp/project',
    });
  });

  test('merge prefers transcript JSON for non-Bash tools', () => {
    expect(mergeCodexToolArguments('write_stdin', { session_id: 1 }, 'write_stdin', {
      session_id: 1,
      chars: 'q',
    })).toEqual({
      session_id: 1,
      chars: 'q',
    });
  });
});
