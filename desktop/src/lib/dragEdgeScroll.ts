export function edgeSpeed(point: number, start: number, end: number, band: number): number {
  const depth = point < start + band ? point - start - band : point > end - band ? point - end + band : 0;
  return Math.sign(depth) * Math.min(1800, Math.abs(depth) * 22);
}

/** One pointer and one animation frame own a selection gesture. */
export function trackSelectionDrag(win: Window, pointerId: number,
  move: (event: PointerEvent) => boolean, tick: (seconds: number) => void) {
  let frame = 0, previous = 0;
  const pause = () => { if (frame) win.cancelAnimationFrame(frame); frame = 0; previous = 0; };
  const next = (now: number) => {
    tick(previous ? Math.min(32, now - previous) / 1000 : 1 / 60);
    if (frame) { previous = now; frame = win.requestAnimationFrame(next); }
  };
  const pointerMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!(event.buttons & 1)) { end(); return; }
    if (move(event)) { if (!frame) frame = win.requestAnimationFrame(next); }
    else pause();
  };
  const pointerEnd = (event: PointerEvent) => { if (event.pointerId === pointerId) end(); };
  const end = () => {
    pause();
    win.removeEventListener("pointermove", pointerMove, true);
    win.removeEventListener("pointerup", pointerEnd, true);
    win.removeEventListener("pointercancel", pointerEnd, true);
    win.removeEventListener("lostpointercapture", pointerEnd, true);
    win.removeEventListener("blur", end);
  };
  win.addEventListener("pointermove", pointerMove, true);
  win.addEventListener("pointerup", pointerEnd, true);
  win.addEventListener("pointercancel", pointerEnd, true);
  win.addEventListener("lostpointercapture", pointerEnd, true);
  win.addEventListener("blur", end);
  return end;
}
