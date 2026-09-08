import { describe, expect, it } from 'vitest';
import {
  anyAgentMultimodalEnabled,
  isAgentMultimodalEnabled,
  isMultimodalSupportedAgent,
} from '../../../src/multimodal/agent-gate.js';
import { MULTIMODAL_SUPPORTED_AGENT_IDS } from '../../../src/types/index.js';

describe('agent multimodal gate', () => {
  it('lists only agents with multimodal extraction implemented', () => {
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('codex');
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('qoder');
    expect(isMultimodalSupportedAgent('codex')).toBe(true);
    expect(isMultimodalSupportedAgent('qoder')).toBe(true);
    // cursor: multimodal extraction not implemented yet
    expect(isMultimodalSupportedAgent('cursor')).toBe(false);
  });

  it('requires a supported agent id and non-none uploadMode', () => {
    const enabled = {
      multimodal: { uploadMode: 'both' as const },
    };
    expect(isAgentMultimodalEnabled('codex', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('qoder', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('cursor', enabled)).toBe(false);
    expect(isAgentMultimodalEnabled('codex', {
      captureMessageContent: false,
      multimodal: { uploadMode: 'both' },
    })).toBe(true);
    expect(isAgentMultimodalEnabled('codex', {
      multimodal: { uploadMode: 'none' },
    })).toBe(false);
    expect(isAgentMultimodalEnabled('codex', {})).toBe(false);
  });

  it('anyAgentMultimodalEnabled scans agents map with id capability check', () => {
    expect(anyAgentMultimodalEnabled({
      cursor: {
        multimodal: { uploadMode: 'both' },
      },
      codex: {
        multimodal: { uploadMode: 'both' },
      },
    })).toBe(true);
    expect(anyAgentMultimodalEnabled({
      cursor: {
        multimodal: { uploadMode: 'both' },
      },
    })).toBe(false);
    expect(anyAgentMultimodalEnabled({})).toBe(false);
    expect(anyAgentMultimodalEnabled({
      codex: {
        multimodal: { uploadMode: 'none' },
      },
    })).toBe(false);
  });
});
