import { describe, expect, it } from 'vitest';
import { diagnosticText } from '../../../../src/pipeline/input/multica/log-diagnostics.js';
import { parseMulticaLog } from '../../../../src/pipeline/input/multica/parsers.js';
import { snapshot } from '../../../../src/pipeline/input/multica/records.js';

describe('Multica diagnostic log content', () => {
  it('retains the original message and native error attributes separately from the canonical event', () => {
    const row = parseMulticaLog(JSON.stringify({time: '2026-11-17T08:00:00Z', level: 'ERROR',
      msg: 'task failed while preparing the repository', task_id: 't1', issue_id: 'i1', runtime_id: 'r1',
      request_id: 'req1', error: {message: 'permission denied', code: 'EACCES', exitCode: 128},
      stack: 'Error: permission denied\n    at checkout (git.ts:42)', stderr: 'fatal: unable to access repository',
      prompt: 'private-task-body', payload: {messages: ['private-model-message']}}));
    expect(row).toMatchObject({message: 'task failed', log_message: 'task failed while preparing the repository',
      task_id: 't1', issue_id: 'i1', runtime_id: 'r1', request_id: 'req1', error_code: 'EACCES', exit_code: '128',
      error_stack: 'Error: permission denied\n    at checkout (git.ts:42)', stderr: 'fatal: unable to access repository'});
    expect(JSON.parse(row!.error_message)).toMatchObject({message: 'permission denied', code: 'EACCES'});
    expect(JSON.stringify(row)).not.toMatch(/private-task-body|private-model-message/);
  });

  it('retains unclassified native warning/error diagnostics instead of dropping them', () => {
    expect(parseMulticaLog('time=2026-11-17T08:00:00Z level=ERROR msg="failed to register runtimes" runtime_id=r1 error="executable not found"'))
      .toMatchObject({message: 'diagnostic log', log_message: 'failed to register runtimes', error_message: 'executable not found', runtime_id: 'r1'});
    expect(parseMulticaLog('INFO arbitrary prompt=private')).toBeUndefined();
  });

  it('removes credentials and request content from messages, nested errors and stacks', () => {
    const secrets = ['test-bearer-value', 'test-cookie-value', 'test-api-key-value', 'test-password-value',
      'test-query-value', 'test-prompt-value', 'test-payload-value', 'sk-testCredential', 'test-basic-value'];
    const row = parseMulticaLog(JSON.stringify({msg: 'task failed Authorization: Bearer test-bearer-value',
      error: {message: '401 token expired', api_key: secrets[2], nested: {password: secrets[3],
        messages: [secrets[5]], payload: secrets[6]}, url: 'https://host/error?token=test-query-value'},
      stack: 'Cookie="test-cookie-value"\nAuthorization: Basic test-basic-value\nat sk-testCredential',
      stderr: 'prompt="test-prompt-value"'}));
    const serialized = JSON.stringify(row);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(row!.error_message).toContain('401 token expired');
    expect(serialized).toContain('[REDACTED]');
  });

  it('recursively redacts prefixed content keys in native and serialized errors', () => {
    const keys = ['task_prompt', 'userPrompt', 'LLMPrompt', 'system_prompt_text', 'chat_messages',
      'user_message', 'modelMessage', 'requestPayload', 'task_payload', 'http.request.body',
      'responseBody', 'tool_arguments', 'tool_result', 'model_input', 'model_output'];
    const nested = Object.fromEntries(keys.map(key => [key, `private-value-for-${key}`]));
    const error = {message: 'permission denied', code: 'EACCES', nested: [{...nested}]};
    const expected = Object.fromEntries(keys.map(key => [key, '[REDACTED]']));
    for (const value of [error, JSON.stringify(error)]) {
      const row = parseMulticaLog(JSON.stringify({msg: 'task failed', error: value}));
      expect(JSON.parse(row!.error_message)).toEqual({message: 'permission denied', code: 'EACCES', nested: [expected]});
      expect(JSON.stringify(row)).not.toContain('private-value-for-');
      const task = snapshot('task_snapshot', {id: 't1', status: 'failed', error: value});
      expect(JSON.stringify(task)).not.toContain('private-value-for-');
    }
  });
  it('redacts before bounding UTF-8 diagnostic text and labels truncation', () => {
    const row = parseMulticaLog(JSON.stringify({msg: 'task failed', error: '失败'.repeat(6000), stack: '函'.repeat(10000)}));
    expect(Buffer.byteLength(row!.error_message)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(row!.error_stack)).toBeLessThanOrEqual(8192);
    expect(row!.error_message).not.toContain('\uFFFD');
    expect(row!.log_content_truncated).toBe('true');
    expect(diagnosticText('token="secret with spaces"')).toBe('token=[REDACTED]');
  });

  it('keeps native exit code zero and leaves absent stack and errors absent', () => {
    const row = parseMulticaLog('{"msg":"task completed","exit_code":0}');
    expect(row).toMatchObject({log_message: 'task completed', exit_code: '0'});
    expect(row).not.toHaveProperty('error_stack');
    expect(row).not.toHaveProperty('error_message');
  });

  it('collects actionable API task errors even when the task log has no error attribute', () => {
    const row = snapshot('task_snapshot', {id: 't1', status: 'failed', error: '401 token expired; api_key="test-api-secret"',
      prompt: 'private-prompt', result: 'private-result'});
    expect(row.error_message).toBe('401 token expired; api_key=[REDACTED]');
    expect(row.failure_reason).toBe('provider_auth_or_access');
    expect(JSON.stringify(row)).not.toMatch(/test-api-secret|private-prompt|private-result/);
  });
});
