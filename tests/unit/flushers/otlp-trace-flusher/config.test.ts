import { describe, it, expect } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';

describe('OtlpTraceFlusher - config validation', () => {
  it('throws on missing endpoint', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoint: '',
      protocol: 'http/protobuf',
      headers: { 'x-key': 'val' },
      serviceName: 'test',
    })).toThrow('endpoint is required');
  });

  it('throws on missing serviceName', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoint: 'http://localhost:4318',
      protocol: 'http/protobuf',
      headers: { 'x-key': 'val' },
      serviceName: '',
    })).toThrow('serviceName is required');
  });

  it('does not throw with valid config and empty headers (just warns)', () => {
    expect(() => new OtlpTraceFlusher({
      enabled: true,
      endpoint: 'http://localhost:4318',
      protocol: 'http/protobuf',
      headers: {},
      serviceName: 'test',
    })).not.toThrow();
  });

  it('constructs successfully with complete config', () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoint: 'http://localhost:4318/apm/trace/opentelemetry',
      protocol: 'http/protobuf',
      headers: { 'x-arms-license-key': 'abc' },
      serviceName: 'loongsuite-pilot',
      debug: true,
      captureMessageContent: true,
      turnIdleTimeoutMs: 0,
    });
    expect(flusher.name).toBe('otlp-trace');
  });
});
