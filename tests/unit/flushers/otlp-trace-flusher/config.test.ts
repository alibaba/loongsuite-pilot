import { describe, it, expect } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';

describe('OtlpTraceFlusher - config validation', () => {
  it('throws on empty endpoints', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoints: [],
      protocol: 'http/protobuf',
      serviceName: 'test',
    })).toThrow('endpoints must be non-empty');
  });

  it('throws on missing serviceName', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: '',
    })).toThrow('serviceName is required');
  });

  it('does not throw with empty per-endpoint headers', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: {} }],
      protocol: 'http/protobuf',
      serviceName: 'test',
    })).not.toThrow();
  });

  it('does not throw with undefined per-endpoint headers', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test',
    })).not.toThrow();
  });

  it('constructs successfully with complete config', () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'arms', endpoint: 'http://localhost:4318/apm/trace/opentelemetry', headers: { 'x-arms-license-key': 'abc' } }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      debug: true,
      captureMessageContent: true,
      turnIdleTimeoutMs: 0,
    });
    expect(flusher.name).toBe('otlp-trace');
  });

  it('constructs successfully with multiple endpoints', () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [
        { name: 'a', endpoint: 'http://a:4318' },
        { name: 'b', endpoint: 'http://b:4318', headers: { 'x-arms-license-key': 'k' } },
      ],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
    });
    expect(flusher.name).toBe('otlp-trace');
  });

  it('passes resourceAttributes to buildResource', () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test',
      resourceAttributes: { 'acs.arms.service.feature': 'genai_app', 'custom.key': 'val' },
    });
    expect(flusher.name).toBe('otlp-trace');
  });
});
