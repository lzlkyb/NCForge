/** Coalesce high-frequency pointer events; release flushes the last position before persisting. */
export function frameTask<T>(apply: (value: T) => void) {
  let frame: number | undefined;
  let latest: { value: T } | undefined;
  const flush = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    const pending = latest; latest = undefined;
    if (pending) apply(pending.value);
  };
  return {
    schedule(value: T) {
      latest = { value };
      if (frame === undefined) frame = requestAnimationFrame(flush);
    },
    flush,
    cancel() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined; latest = undefined;
    },
  };
}
