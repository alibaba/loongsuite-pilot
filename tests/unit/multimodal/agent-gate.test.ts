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
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('qwen-work-cn');
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('antigravity');
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('antigravity-cli');
    expect(isMultimodalSupportedAgent('codex')).toBe(true);
    expect(isMultimodalSupportedAgent('qoder')).toBe(true);
    expect(isMultimodalSupportedAgent('qwen-work-cn')).toBe(true);
    expect(isMultimodalSupportedAgent('antigravity')).toBe(true);
    expect(isMultimodalSupportedAgent('antigravity-cli')).toBe(true);
    expect(isMultimodalSupportedAgent('antigravity-ide')).toBe(false);
    // cursor: multimodal extraction not implemented yet
    expect(isMultimodalSupportedAgent('cursor')).toBe(false);
  });

  it('requires supported agent id, message capture, and non-none uploadMode', () => {
    const enabled = {
      captureMessageContent: true,
      multimodal: { uploadMode: 'all' as const },
    };
    expect(isAgentMultimodalEnabled('codex', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('qoder', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('qwen-work-cn', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('antigravity', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('antigravity-cli', enabled)).toBe(true);
    expect(isAgentMultimodalEnabled('cursor', enabled)).toBe(false);
    expect(isAgentMultimodalEnabled('codex', {
      captureMessageContent: false,
      multimodal: { uploadMode: 'all' },
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
        multimodal: { uploadMode: 'all' },
      },
      codex: {
        captureMessageContent: true,
        multimodal: { uploadMode: 'all' },
      },
    })).toBe(true);
    expect(anyAgentMultimodalEnabled({
      cursor: {
        captureMessageContent: true,
        multimodal: { uploadMode: 'all' },
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
