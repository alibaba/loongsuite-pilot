import { INTERNAL_BUILD } from '../core/build-constants.js';

let _sendAlarm: (topic: string, data: Record<string, unknown>) => void;
let _sendStatus: (topic: string, data: Record<string, unknown>) => void;
let _sendRunningStatus: (data: Record<string, unknown>) => void;

if (INTERNAL_BUILD) {
  const m = await import('./alarm-sender.internal.js');
  _sendAlarm = m.sendAlarm;
  _sendStatus = m.sendStatus;
  const s = await import('./statistic.internal.js');
  _sendRunningStatus = s.sendRunningStatus;
} else {
  const m = await import('./alarm-sender.js');
  _sendAlarm = m.sendAlarm;
  _sendStatus = m.sendStatus;
  const s = await import('./statistic.js');
  _sendRunningStatus = s.sendRunningStatus;
}

export const sendAlarm = _sendAlarm;
export const sendStatus = _sendStatus;
export const sendRunningStatus = _sendRunningStatus;
