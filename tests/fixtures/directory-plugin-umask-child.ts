import { DirectoryPluginStrategy } from '../../src/deployment/directory-plugin-strategy.js';
import type { AgentDefinition } from '../../src/types/index.js';

// A subprocess owns its umask; changing it in a Vitest worker thread is unsafe.
const options = JSON.parse(process.env.PILOT_TEST_DIRECTORY_OPTIONS ?? '{}') as {
  dataDir: string;
  definition: AgentDefinition;
  pretendRoot: boolean;
};
process.umask(0o077);
process.env.LOONGSUITE_PILOT_ROOT_TRIGGER = '1';
if (options.pretendRoot) Object.defineProperty(process, 'getuid', { value: () => 0 });

class RecordingStrategy extends DirectoryPluginStrategy {
  protected override async runActivationCommand(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: '', stderr: '' };
  }
}

const result = await new RecordingStrategy(options.dataDir).deploy(options.definition);
if (!result.success) {
  console.error(result.error);
  process.exitCode = 1;
}
