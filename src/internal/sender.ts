import { INTERNAL_BUILD } from '../core/build-constants.js';

let _sendAlarm: (data: Record<string, unknown>) => void;
let _sendStatus: (data: Record<string, unknown>) => void;

if (INTERNAL_BUILD) {
  const m = await import('./alarm-sender.internal.js');
  _sendAlarm = m.sendAlarm;
  _sendStatus = m.sendStatus;
} else {
  const m = await import('./alarm-sender.js');
  _sendAlarm = m.sendAlarm;
  _sendStatus = m.sendStatus;
}

export const sendAlarm = _sendAlarm;
export const sendStatus = _sendStatus;
