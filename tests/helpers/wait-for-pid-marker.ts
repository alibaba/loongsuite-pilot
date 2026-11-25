import { readFile } from 'node:fs/promises';

/** Test-fixture handshake: existence alone does not mean the writer released its handle. */
export async function waitForPidMarker(
  file: string,
  diagnostic = () => '',
  { timeoutMs = 15_000, intervalMs = 10, read = (name: string) => readFile(name, 'utf8') } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let state = 'not ready';
  while (true) {
    try {
      const text = (await read(file)).replace(/^\uFEFF/, '').trim();
      const pid = Number(text);
      if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(pid)) return pid;
      state = text ? 'invalid PID' : 'empty marker';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EBUSY') throw error;
      state = code;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for native PID marker ${file} (${state}); ${diagnostic()}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
