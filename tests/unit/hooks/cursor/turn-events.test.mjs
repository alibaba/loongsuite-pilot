import { expect, it } from 'vitest';
import { selectTurnEvents } from '../../../../assets/hooks/cursor/turn-events.mjs';
function event(hook_event, generation_id, seconds) {
  return { hook_event, generation_id, conversation_id: 'session', _journal_ts: `2026-11-23T08:00:0${seconds}.000Z` };
}
it('retains a different generation that arrives before its prompt and includes thought aliases', () => {
  const prompt = event('beforeSubmitPrompt', 'old', 0);
  const thought = event('afterAgentThought', 'old-0-abcd', 1);
  const nextTool = event('preToolUse', 'new', 2);
  const stop = event('stop', 'old', 3);
  const snapshot = [prompt, thought, nextTool, stop];
  expect(selectTurnEvents(snapshot, stop)).toEqual([prompt, thought, stop]);
  const nextPrompt = event('beforeSubmitPrompt', 'new', 4);
  const nextStop = event('stop', 'new', 5);
  expect(selectTurnEvents([...snapshot, nextPrompt, nextStop], nextStop)).toEqual([nextTool, nextPrompt, nextStop]);
});
it('uses prompt boundaries when generation IDs are absent', () => {
  const oldPrompt = event('beforeSubmitPrompt', undefined, 0);
  const oldStop = event('stop', undefined, 1);
  const newPrompt = event('beforeSubmitPrompt', undefined, 2);
  const newStop = event('stop', undefined, 3);
  const snapshot = [oldPrompt, oldStop, newPrompt, newStop];
  expect(selectTurnEvents(snapshot, oldStop)).toEqual([oldPrompt, oldStop]);
  expect(selectTurnEvents(snapshot, newStop)).toEqual([newPrompt, newStop]);
});
