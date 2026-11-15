// Kept independent of workspace/debug imports so switching can wait for the runner safely.
interface RunLifecycle { cancelled: boolean; cancel: () => Promise<void>; done: Promise<void>; finish: () => void; }
let active: RunLifecycle | null = null;
let switching = 0;
export function beginJavaRun(cancel: () => Promise<void>): RunLifecycle | null {
  if (switching > 0 || active) return null;
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const run: RunLifecycle = { cancelled: false, cancel, done, finish: () => { if (active === run) active = null; complete(); } };
  active = run;
  return run;
}
export async function cancelJavaRunAndWait(): Promise<void> {
  const run = active;
  if (!run) return;
  run.cancelled = true;
  await run.cancel();
  await run.done;
}
export async function withJavaRunsStopped<T>(work: () => Promise<T>): Promise<T> {
  switching++;
  try { await cancelJavaRunAndWait(); return await work(); }
  finally { switching--; }
}
