import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../../../src/core/orchestrator.js';
vi.mock('../../../src/utils/logger.js', () => ({ createLogger: () => ({ info:vi.fn(),debug:vi.fn(),warn:vi.fn(),error:vi.fn() }) }));
vi.mock('../../../src/core/build-constants.js', () => ({ PROPRIETARY_BUILD: false }));
describe('Copilot watchdog lifecycle', () => {
  it('checks and repairs enabled plugins and retries incomplete disabled cleanup', async () => {
    const def={id:'copilot',deployMode:'copilot-plugin',copilotPlugin:{}};
    const manager={getDefinitions:()=>[def],hasRecord:vi.fn().mockReturnValue(true),isAgentDetected:vi.fn().mockResolvedValue(true),
      needsRedeploy:vi.fn().mockResolvedValue(true),deploySingle:vi.fn().mockResolvedValue({success:true}),undeployAgent:vi.fn().mockResolvedValue(false)};
    const orch=new Orchestrator({dataDir:'/tmp/copilot-watchdog',agents:{copilot:{enabled:true}}} as any);
    (orch as any).deploymentManager=manager;
    const [target]=(orch as any).buildCopilotPluginInterceptTargets();
    expect(target.enabled()).toBe(true);expect(await target.precondition()).toBe(true);expect(await target.check()).toBe(false);
    await target.repair();expect(manager.deploySingle).toHaveBeenCalledWith(def);
    manager.deploySingle.mockResolvedValueOnce({success:true,skipped:true} as any);await expect(target.repair()).rejects.toThrow();
    await expect(target.cleanup()).rejects.toThrow('cleanup incomplete');
    manager.undeployAgent.mockResolvedValueOnce(true);await expect(target.cleanup()).resolves.toBeUndefined();
    manager.hasRecord.mockReturnValue(false);manager.undeployAgent.mockClear();await target.cleanup();expect(manager.undeployAgent).not.toHaveBeenCalled();
    (orch as any).config.agents.copilot.enabled=false;expect(target.enabled()).toBe(false);
  });
});
