// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSwitch } from "./useProjectSwitch";
import { clearCompletedOperations, getOperations } from "../lib/operations";
const h=vi.hoisted(()=>({ensure:vi.fn(),apply:vi.fn(),toast:vi.fn()}));
vi.mock("../lib/terminatePreflight",()=>({ensureFilesSaved:h.ensure}));
vi.mock("../lib/switchWorkspace",()=>({applyWorkspace:h.apply}));
vi.mock("../components/ui/toast",()=>({toast:h.toast}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let api:ReturnType<typeof useProjectSwitch>,root:Root,host:HTMLDivElement;
function Harness(){api=useProjectSwitch({root:"C:\\old",projects:[],queryClient:new QueryClient(),setRoot:vi.fn(),setEditingRoot:vi.fn(),openFile:vi.fn()});return null;}
beforeEach(()=>{vi.clearAllMocks();clearCompletedOperations();h.ensure.mockResolvedValue(true);h.apply.mockResolvedValue("C:\\new");host=document.createElement("div");document.body.append(host);root=createRoot(host);act(()=>root.render(<Harness/>));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("工程切换等待",()=>{
  it("保存确认阶段已同步锁定其它入口，只有一次实际切换",async()=>{
    let resolve!:(x:boolean)=>void;h.ensure.mockReturnValue(new Promise(yes=>{resolve=yes;}));let first!:Promise<string|null>,second!:Promise<string|null>;
    act(()=>{first=api.applyRoot("C:\\new");second=api.applyRoot("C:\\other");});expect(h.ensure).toHaveBeenCalledOnce();expect(await second).toContain("正在切换");
    await act(async()=>{resolve(true);await first;});expect(h.apply).toHaveBeenCalledOnce();expect(getOperations()[0].detail).toContain("代码智能");
  });
  it("用户取消保留当前工程，后端异常结束失败",async()=>{
    h.ensure.mockResolvedValueOnce(false);await act(async()=>{await api.applyRoot("C:\\new");});expect(h.apply).not.toHaveBeenCalled();expect(getOperations()[0].state).toBe("cancelled");
    h.apply.mockRejectedValueOnce(Error("目录不存在"));await act(async()=>{await api.applyRoot("C:\\missing");});expect(getOperations()[1].state).toBe("failed");
  });
});
