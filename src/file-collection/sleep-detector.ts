import { EventEmitter } from 'node:events';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SleepDetector');

const CHECK_INTERVAL_MS = 5_000;
const SLEEP_THRESHOLD_MS = 15_000;

export interface WakeEvent {
  sleepDurationMs: number;
}

export class SleepDetector extends EventEmitter {
  private lastTickTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    this.lastTickTime = Date.now();
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeAllListeners('wake');
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickTime;
    this.lastTickTime = now;

    if (elapsed > SLEEP_THRESHOLD_MS) {
      const sleepDurationMs = elapsed - CHECK_INTERVAL_MS;
      logger.info('system wake detected', {
        elapsedMs: elapsed,
        estimatedSleepMs: sleepDurationMs,
      });
      this.emit('wake', { sleepDurationMs } satisfies WakeEvent);
    }
  }
}
