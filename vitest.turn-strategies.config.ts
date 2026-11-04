import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Producer/Input protocol coverage for the shared completed-turn executor.
// GUI/native client installation acceptance remains a separate validation layer.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'tests/unit/flushers/**/*.test.ts',
      'tests/integration/additional-producer-turn-strategies.test.ts',
      'tests/integration/completed-turn-producers.test.ts',
      'tests/integration/qoder-native-transcript-pipeline.test.ts',
      'tests/integration/qoder-recovery-ownership.test.ts',
      'tests/integration/qoder-cli-segment-span-timing.test.ts',
      'tests/integration/openclaw-plugin-event-log-flow.test.ts',
      'tests/integration/hermes-agent-event-log-flow.test.ts',
      'tests/integration/hermes-upstream-link.test.ts',
      'tests/integration/hermes-delayed-input.test.ts',
      'tests/integration/qwen-subagent-event-log-flow.test.ts',
      'tests/integration/doubao-work-pipeline.test.ts',
      'tests/unit/hooks/openclaw/plugin.test.mjs',
      'tests/unit/hooks/hermes-subagent.test.mjs',
      'tests/unit/hooks/opencode-plugin-session.test.mjs',
      'tests/unit/hooks/grok-build/processor-lifecycle.test.mjs',
      'tests/unit/hooks/kiro-cli/hook-processor.test.mjs',
      'tests/unit/inputs/qoder-work-trace-input.test.ts',
      'tests/unit/inputs/qoder-work-cn-trace-input.test.ts',
      'tests/unit/inputs/qoder-cn-sqlite-input.test.ts',
      'tests/unit/inputs/qoder-work-log-input.test.ts',
      'tests/unit/inputs/qoder-work-sqlite-input.test.ts',
      'tests/unit/inputs/qwen-work-cn-trace-input.test.ts',
      'tests/unit/inputs/qwen-work-cn-input.test.ts',
      'tests/unit/inputs/qwen-work-cn-sqlite-input.test.ts',
      'tests/unit/inputs/copilot-log/copilot-log-input.test.ts',
      'tests/unit/inputs/codex-transcript/codex-transcript-input.test.ts',
      'tests/unit/inputs/dsh-log/dsh-otlp-grouping.test.ts',
      'tests/unit/inputs/dsh-log/dsh-log-input.test.ts',
      'tests/unit/inputs/workbuddy-input.test.ts',
      'tests/unit/inputs/wukong-input.test.ts',
    ],
  },
});
