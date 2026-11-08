// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryField } from "./QueryField";
import { QueryElapsed, SqlExecutionFeedback } from "./SqlExecutionFeedback";
import { beginOperation, cancelOperation, clearCompletedOperations } from "../../lib/operations";
vi.mock("../../lib/appVisibility", () => ({ useAppHidden: () => false }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host:HTMLDivElement;
let root:ReturnType<typeof createRoot>;
const disconnect=vi.fn(),cancelFrame=vi.fn();
beforeEach(()=>{
 host=document.createElement("div");document.body.append(host);root=createRoot(host);
 vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
 vi.stubGlobal("ResizeObserver",class {observe(){} disconnect=disconnect;});
 vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",cancelFrame);
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({setTransform:vi.fn()} as unknown as CanvasRenderingContext2D);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();clearCompletedOperations();vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});
it("retained results stay marked while querying, cancellation never becomes success, and resources release",async()=>{
 await act(async()=>root.render(<QueryField host={host} state="running" previous />));
 expect(host.dataset.queryField).toBe("previous");expect(host.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
 await act(async()=>root.render(<QueryField host={host} state="cancelling" previous />));
 expect(host.dataset.queryOutcome).toBe("cancelling");
 await act(async()=>root.render(<QueryField host={host} state="cancelled" previous={false} />));
 expect(host.dataset.queryOutcome).toBe("cancelled");
 await act(async()=>root.unmount());
 expect(host.dataset.queryField).toBeUndefined();expect(disconnect).toHaveBeenCalled();expect(cancelFrame).toHaveBeenCalled();
 root=createRoot(host);
});
it("opening an old result does not replay its completion animation",async()=>{
 await act(async()=>root.render(<QueryField host={host} state="success" previous={false}/>));
 expect(host.dataset.queryOutcome).toBeUndefined();
});
it("status stays inline and preserves script progress and stop confirmation",async()=>{
 const task=beginOperation({key:"query-motion-test",label:"执行",cancel:async()=>{}})!;
 await act(async()=>{task.update({progress:{done:2,total:5}});root.render(<SqlExecutionFeedback executionId={task.id} previousAt={0}/>);});
 expect(host.firstElementChild?.tagName).toBe("SPAN");expect(host.textContent).toContain("2 / 5");
 await act(async()=>cancelOperation(task.id));expect(host.textContent).toContain("等待数据库停止确认");
 await act(async()=>task.finish("cancelled"));expect(host.textContent).toContain("执行已停止");
});
it("elapsed time lives in its own component and clears its timer",async()=>{
 vi.useFakeTimers();
 await act(async()=>root.render(<QueryElapsed startedAt={Date.now()}/>));
 await act(async()=>vi.advanceTimersByTime(1200));expect(host.textContent).toContain("1.2s");
 await act(async()=>root.unmount());expect(vi.getTimerCount()).toBe(0);root=createRoot(host);vi.useRealTimers();
});
