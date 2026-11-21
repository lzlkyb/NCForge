// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationStatus } from "./OperationStatus";
import { beginOperation, clearCompletedOperations, getOperations } from "../../lib/operations";
const h=vi.hoisted(()=>({openFile:vi.fn(),setSession:vi.fn()}));
vi.mock("../../lib/openFileRequest",()=>({requestOpenFile:h.openFile}));
vi.mock("../../lib/workspaceSession",()=>({setSession:h.setSession}));
vi.mock("../../hooks/usePresence",()=>({usePresence:(open:boolean)=>({mounted:open,entered:open})}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.clearAllMocks();clearCompletedOperations();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("运行任务入口",()=>{
  it("两个入口互斥，Escape返回焦点，结束后不隐藏已打开面板",()=>{
    const task=beginOperation({key:"ui",label:"编译",page:"files"})!;
    act(()=>root.render(<><OperationStatus/><OperationStatus compact/></>));
    const top=host.querySelector<HTMLButtonElement>("button")!;act(()=>top.click());expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    act(()=>task.finish("failed","编译失败"));const bottom=host.querySelectorAll<HTMLButtonElement>("button")[1];act(()=>bottom.click());
    const panels=document.querySelectorAll('[role="dialog"]');expect(panels).toHaveLength(1);expect(panels[0].id).toBe(bottom.getAttribute("aria-controls"));
    act(()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));expect(document.activeElement).toBe(bottom);expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
  it("显示实际进度，返回服务来源打开正确底部面板，清理保留活动项",()=>{
    const task=beginOperation({key:"ui-progress",label:"启动服务",page:"files",panel:"svc"})!;task.update({progress:{done:2,total:6}});
    const completed=beginOperation({key:"ui-done",label:"已结束"})!;completed.finish();
    act(()=>root.render(<OperationStatus/>));act(()=>host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector("progress")?.value).toBe(2);expect(document.querySelector("progress")?.max).toBe(6);
    const clear=[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="清除已结束")!;act(()=>clear.click());expect(getOperations()).toHaveLength(1);
    const go=[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="返回来源")!;act(()=>go.click());expect(h.setSession).toHaveBeenCalledWith({panelOpen:true,panelTab:"svc"});act(()=>task.finish());
  });
  it("后台进度和部分完成只更新计数，详情保持关闭，输入焦点不变",()=>{
    act(()=>root.render(<><textarea defaultValue="draft"/><OperationStatus compact/></>));
    const editor=host.querySelector("textarea")!;
    editor.focus(); editor.setSelectionRange(1, 3);
    const task=beginOperation({key:"ui-partial",label:"导出"})!;
    act(()=>{task.update({progress:{done:4,total:10}});task.finish("partial","保留 4 行");});
    expect(host.textContent).toContain("1 待查看");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart,editor.selectionEnd]).toEqual([1,3]);
    act(()=>host.querySelector("button")!.click());
    expect(document.querySelector(".op-panel")?.getAttribute("data-anchor")).toBe("bottom");
    expect(document.querySelector(".op-panel")?.textContent).toContain("保留 4 行");
    editor.focus();
    const escape=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
    act(()=>editor.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);
  });
});
