// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useServiceLogActions } from "./useServiceLogActions";
import { TaskFeedback } from "../components/ui/TaskFeedback";

const mocks=vi.hoisted(()=>({export:vi.fn(),copy:vi.fn()}));
vi.mock("../lib/serviceConsoleApi",()=>({serviceLogExport:mocks.export,serviceLogExportText:mocks.export,
  serviceLogClear:vi.fn(),serviceLogPurge:vi.fn()}));
vi.mock("../lib/errorToast",()=>({errorToast:vi.fn()}));
vi.mock("../components/ui/toast",()=>({toast:vi.fn()}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement,actions:ReturnType<typeof useServiceLogActions>;
let complete:(value:null)=>void;
function Harness(){
  actions=useServiceLogActions({target:"middleware",previous:false,reset:vi.fn(),onCleared:vi.fn()});
  return <TaskFeedback active={!!actions.busy} label="正在导出日志…" onCancel={actions.cancel}
    cancelling={actions.cancelling} operationKey={actions.operationId} startedAt={actions.startedAt}/>;
}
beforeEach(()=>{
  vi.useFakeTimers();mocks.export.mockReset();
  mocks.export.mockImplementation(()=>new Promise<null>(resolve=>{complete=resolve;}));
  vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});

it("shows cancellation pending until the export confirms, then clears the running feedback",async()=>{
  await act(async()=>root.render(<Harness/>));
  await act(async()=>actions.exportLog());
  const signal=mocks.export.mock.calls[0][3] as AbortSignal;
  expect(actions.busy).toBe("导出日志");expect(signal.aborted).toBe(false);
  await act(async()=>host.querySelector("button")!.click());
  expect(signal.aborted).toBe(true);expect(actions.cancelling).toBe(true);
  expect(actions.busy).toBe("导出日志");expect(host.textContent).toContain("等待任务确认");
  expect(host.querySelector("button")?.disabled).toBe(true);
  await act(async()=>complete(null));
  expect(actions.busy).toBeNull();expect(actions.cancelling).toBe(false);
  expect(host.textContent).toBe("");expect(vi.getTimerCount()).toBe(0);
});

it("blocks duplicate export requests and starts a fresh identity after completion",async()=>{
  await act(async()=>root.render(<Harness/>));
  await act(async()=>{actions.exportLog();actions.exportLog();});
  expect(mocks.export).toHaveBeenCalledOnce();
  const first=actions.operationId;
  await act(async()=>complete(null));
  await act(async()=>actions.exportLog());
  expect(actions.operationId).not.toBe(first);expect(actions.cancelling).toBe(false);
  await act(async()=>complete(null));
});
