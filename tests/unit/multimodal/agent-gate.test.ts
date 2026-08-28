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
    expect(isMultimodalSupportedAgent('codex')).toBe(true);
    // cursor: multimodal extraction not implemented yet
    expect(isMultimodalSupportedAgent('cursor')).toBe(false);
  });

  it('requires supported agent id, message capture, and non-none uploadMode', () => {
    const enabled = {
      captureMessageContent: true,
      multimodal: { uploadMode: 'both' as const },
    };
    expect(isAgentMultimodalEnabled('codex', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('cursor', enabled)).toBe(false);
    expect(isAgentMultimodalEnabled('codex', {
      captureMessageContent: false,
      multimodal: { uploadMode: 'both' },
    })).toBe(false);
    expect(isAgentMultimodalEnabled('codex', {
      captureMessageContent: true,
      multimodal: { uploadMode: 'none' },
    })).toBe(false);
    expect(isAgentMultimodalEnabled('codex', { captureMessageContent: true })).toBe(false);
  });

  it('anyAgentMultimodalEnabled scans agents map with id capability check', () => {
    expect(anyAgentMultimodalEnabled({
      cursor: {
        captureMessageContent: true,
        multimodal: { uploadMode: 'both' },
      },
      codex: {
        captureMessageContent: true,
        multimodal: { uploadMode: 'both' },
      },
    })).toBe(true);
    expect(anyAgentMultimodalEnabled({
      cursor: {
        captureMessageContent: true,
        multimodal: { uploadMode: 'both' },
      },
    })).toBe(false);
    expect(anyAgentMultimodalEnabled({})).toBe(false);
    expect(anyAgentMultimodalEnabled({
      codex: {
        captureMessageContent: true,
        multimodal: { uploadMode: 'none' },
      },
    })).toBe(false);
  });
});

