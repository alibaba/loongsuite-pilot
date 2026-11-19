import type { ChildProcess } from 'node:child_process';

export interface ManagedChildState {
  id: number;
  pid: number;
  processGroup: boolean;
  command: string;
  running: boolean;
}

let observer: ((state: ManagedChildState) => void) | undefined;
let seq = 0;

/** Installed only in the interceptor Worker so its parent can reap orphaned script groups. */
export function setManagedChildObserver(next: (state: ManagedChildState) => void): void {
  observer = next;
}

export function trackManagedChild(child: ChildProcess, processGroup = false): void {
  if (!observer || child.pid === undefined) return;
  const state = { id: ++seq, pid: child.pid, processGroup, command: child.spawnargs.join(' ') };
  observer({ ...state, running: true });
  // close, rather than exit: a shell may exit while descendants still hold its stdout pipe.
  child.once('close', () => observer?.({ ...state, running: false }));
}
