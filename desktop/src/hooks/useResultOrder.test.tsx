// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useResultOrder } from "./useResultOrder";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
const workers: FakeWorker[]=[];
class FakeWorker {
  onmessage: ((e: MessageEvent)=>void)|null=null; onerror:(()=>void)|null=null;
  terminate=vi.fn(); postMessage=vi.fn();
  constructor(){workers.push(this);}
}
const columns=[{name:"NAME",type:"VARCHAR2",precision:0,scale:0}];
const rows=Array.from({length:20000},(_,i)=>[String(i)]);
let host:HTMLDivElement, root:ReturnType<typeof createRoot>, latest:ReturnType<typeof useResultOrder>;
function Test({filter}:{filter:string}){latest=useResultOrder(rows,columns,filter,null);return null;}
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal("Worker",FakeWorker);workers.length=0;host=document.createElement("div");root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();});
it("debounces requests and rejects late messages from cancelled workers",()=>{
  act(()=>root.render(<Test filter="1"/>));
  expect(workers).toHaveLength(0);act(()=>vi.advanceTimersByTime(120));expect(workers).toHaveLength(1);
  act(()=>root.render(<Test filter="2"/>));expect(workers[0].terminate).toHaveBeenCalled();
  act(()=>workers[0].onmessage?.({data:{order:[1]}} as MessageEvent));expect(latest.pending).toBe(true);expect(latest.order).toEqual([]);
  act(()=>vi.advanceTimersByTime(120));act(()=>workers[1].onmessage?.({data:{order:[2]}} as MessageEvent));
  expect(latest.order).toEqual([2]);expect(latest.pending).toBe(false);
});
it("exposes worker failures and retries without running the expensive calculation synchronously",()=>{
  act(()=>root.render(<Test filter="1"/>));act(()=>vi.advanceTimersByTime(120));act(()=>workers[0].onerror?.());
  expect(latest.error).toContain("重试");act(()=>latest.retry());expect(latest.pending).toBe(true);
  act(()=>vi.advanceTimersByTime(120));expect(workers).toHaveLength(2);
});
it("splits worker input into bounded messages and stops pumping when cancelled",async()=>{
  act(()=>root.render(<Test filter="1"/>));
  act(()=>vi.advanceTimersByTime(120));
  expect(workers[0].postMessage.mock.calls[0][0]).toMatchObject({kind:"init"});
  expect(workers[0].postMessage.mock.calls[1][0].rows).toHaveLength(128);
  act(()=>root.render(<Test filter="2"/>));
  const count=workers[0].postMessage.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(10);});
  expect(workers[0].postMessage).toHaveBeenCalledTimes(count);
});
