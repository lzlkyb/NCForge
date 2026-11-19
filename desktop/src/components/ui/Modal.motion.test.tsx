// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "./Modal";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("releases focus and disables closing content immediately while retaining a reversible visual exit", () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => window.setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  function Probe() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Open</button>
    <Modal open={open} onClose={() => setOpen(false)} ariaLabel="Motion"><button onClick={() => setOpen(false)}>Close</button><input defaultValue="draft" /></Modal></>; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(<Probe />)); const trigger = host.querySelector("button")!; trigger.focus();
    act(() => trigger.click()); const dialog = document.querySelector<HTMLElement>('[aria-label="Motion"]')!;
    const close = dialog.querySelector("button")!; close.focus();
    act(() => close.click());
    expect(document.activeElement).toBe(trigger);
    expect(dialog.parentElement?.inert).toBe(true); expect(dialog.parentElement?.getAttribute("aria-hidden")).toBe("true");
    act(() => trigger.click()); act(() => vi.advanceTimersByTime(180));
    expect(document.querySelector('[aria-label="Motion"]')).toBe(dialog);
    expect(dialog.parentElement?.inert).toBe(false); expect(dialog.querySelector("input")?.value).toBe("draft");
  } finally { act(() => root.unmount()); host.remove(); }
});
