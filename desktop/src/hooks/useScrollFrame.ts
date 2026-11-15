import { useEffect, useMemo, useRef } from "react";

/** Native scrolling owns the pixels; React receives at most one viewport update per paint. */
export function useScrollFrame(callback: () => void) {
  const latest = useRef(callback), frame = useRef<number | null>(null);
  latest.current = callback;
  const control = useMemo(() => {
    const cancel = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
    const flush = () => { cancel(); latest.current(); };
    return {
      schedule: () => { if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; latest.current(); }); },
      flush, cancel,
    };
  }, []);
  useEffect(() => control.cancel, [control]);
  return control;
}

/** Session offsets are saved after a gesture, or on exit, without broadcasting every scroll frame. */
export function useScrollIdle<T>(callback: (value: T) => void) {
  const latest = useRef(callback), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ callback: (value: T) => void; value: T } | null>(null);
  latest.current = callback;
  const control = useMemo(() => {
    const cancel = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; pending.current = null; };
    const flush = () => {
      if (timer.current === null) return;
      clearTimeout(timer.current); timer.current = null;
      const work = pending.current; pending.current = null; work?.callback(work.value);
    };
    return {
      schedule: (value: T) => { pending.current = { callback: latest.current, value }; if (timer.current !== null) clearTimeout(timer.current); timer.current = setTimeout(flush, 150); },
      flush, cancel,
    };
  }, []);
  useEffect(() => control.flush, [control]);
  return control;
}
