import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { InputRuntimeAccumulator } from './input-runtime-metrics.js';

export const LINE_TAIL_READ_BYTES = 16 * 1024 * 1024;

/** Read one bounded window and commit only complete lines or an explicit oversized-line skip. */
export async function readBoundedLineTail(
  file: string,
  stat: Stats,
  offset: number,
  skippingLine: boolean,
  runtime: InputRuntimeAccumulator | null,
) {
  runtime?.observeBacklog(stat.size - offset);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size < stat.size) {
      throw new Error('log source changed before reading');
    }
    const buffer = Buffer.allocUnsafe(Math.min(stat.size - offset, LINE_TAIL_READ_BYTES));
    const started = runtime?.now();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (runtime && started !== undefined) {
      runtime.observeRead(bytesRead, buffer.length, runtime.now() - started);
    }
    const data = buffer.subarray(0, bytesRead);
    const start = skippingLine ? data.indexOf(0x0a) + 1 : 0;
    if (skippingLine && start === 0) {
      return { text: '', offset: offset + bytesRead, skippingLine, beganSkip: false };
    }
    const end = data.lastIndexOf(0x0a) + 1;
    if (end > 0) {
      return { text: data.toString('utf8', start, end), offset: offset + end, skippingLine: false, beganSkip: false };
    }
    const beganSkip = bytesRead === LINE_TAIL_READ_BYTES;
    return { text: '', offset: beganSkip ? offset + bytesRead : offset, skippingLine: beganSkip, beganSkip };
  } finally {
    await handle.close();
  }
}
