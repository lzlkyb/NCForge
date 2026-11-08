// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultTransferDialog } from "./ResultTransferDialog";
import { useResultTransferDialog } from "../../hooks/useResultTransferDialog";
import type { TransferFrame } from "../../lib/resultTransferContext";
import { dbTransferApi } from "../../lib/dbTransferApi";
import { copyTransfer } from "../../lib/resultTransferClipboard";
import { startTransferJob } from "../../lib/resultTransferJobs";
import { saveTransferPreset } from "../../lib/resultTransferPresets";
import { defaultTransferOptions } from "../../lib/resultTransfer";
import { TransferPreview } from "./TransferPreview";
vi.mock("../../lib/dbTransferApi",()=>({dbTransferApi:{pick:vi.fn(),file:vi.fn(),open:vi.fn()}}));
vi.mock("../../lib/resultTransferClipboard",()=>({copyTransfer:vi.fn()}));
vi.mock("../../lib/resultTransferJobs",()=>({startTransferJob:vi.fn(),transferJobKey:()=>"frame",useTransferJob:()=>null,clearTransferJob:vi.fn(),stopTransferJob:vi.fn()}));
vi.mock("../ui/toast",()=>({toast:vi.fn()}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root, host:HTMLDivElement, c:ReturnType<typeof useResultTransferDialog>;
const frame:TransferFrame={data:{columns:[{name:"ID",type:"CHAR",precision:20,scale:0},{name:"NAME",type:"VARCHAR2",precision:80,scale:0}],rows:[["0001","甲"],["0002","乙"]]},order:[1,0],visible:[1,0],selection:{anchor:{r:1,c:1},end:{r:1,c:1}},labels:["主键","名称"],source:{connId:"c",resultId:"r",sql:"select * from T where ID = ?",params:["0002"],source:"测试库",complete:false,table:"T",sheets:[{name:"一",data:{columns:[{name:"A",type:"CHAR",precision:20,scale:0}],rows:[["a"]]}},{name:"二",data:{columns:[{name:"B",type:"CHAR",precision:20,scale:0},{name:"C",type:"CHAR",precision:20,scale:0}],rows:[["b","c"]]}}]}};
function Harness({mode="file"}:{mode?:"copy"|"file"}){c=useResultTransferDialog(frame,mode);return null;}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();});
it("选区默认一列一行，取消全部列阻止输出",async()=>{
  act(()=>root.render(<Harness mode="copy"/>));expect(c.summary).toContain("1 行 × 1 列");expect(c.state.options.columnIndices).toEqual([1]);
  act(()=>c.columns([]));expect(c.error).toContain("至少一个");await act(async()=>c.run());expect(copyTransfer).not.toHaveBeenCalled();
});
it("多个异构结果集按全字段发送，不能误用第一结果列索引",async()=>{
  act(()=>root.render(<Harness/>));act(()=>c.allSets(true));expect(c.state.scope).toBe("loaded");expect(c.state.options.header).toBe("name");
  await act(async()=>c.run());expect(startTransferJob).toHaveBeenCalledWith(frame.source,expect.objectContaining({sheets:frame.source.sheets,expectedColumns:undefined,data:undefined}),expect.stringContaining("全部已加载结果集"),expect.objectContaining({frame,seed:expect.objectContaining({allSets:true})}));
});
it("重查询参数来自冻结来源，失败的原生选择不清除现有位置",async()=>{
  act(()=>root.render(<Harness/>));act(()=>c.scope("query"));await act(async()=>c.run());expect(startTransferJob).toHaveBeenLastCalledWith(frame.source,expect.objectContaining({sql:frame.source.sql,params:["0002"],data:undefined}),expect.any(String),expect.objectContaining({frame}));
  vi.mocked(dbTransferApi.pick).mockResolvedValueOnce({token:"t",path:"D:/结果.xlsx"});await act(async()=>c.pick());
  expect(c.state.fileName).toBe("结果.xlsx");
  vi.mocked(dbTransferApi.pick).mockResolvedValueOnce(null);await act(async()=>c.pick());expect(c.state.destination?.token).toBe("t");
  vi.mocked(dbTransferApi.pick).mockRejectedValueOnce(Error("不可写"));await act(async()=>c.pick());expect(c.state.error).toContain("不可写");expect(c.state.destination?.token).toBe("t");
  act(()=>c.format("json"));expect(c.state.destination).toBeNull();expect(c.state.fileName).toMatch(/\.json$/);
});
it("文件名改变使旧保存授权失效；复制模式应用XLSX预设安全回退",()=>{
  saveTransferPreset("工作簿",defaultTransferOptions("xlsx"));act(()=>root.render(<Harness mode="copy"/>));
  act(()=>c.applyPreset(5));expect(c.state.options.format).toBe("tsv");expect(c.error).toBeNull();
  act(()=>c.patch({destination:{token:"old",path:"D:/old.tsv"}}));act(()=>c.patch({fileName:"new.tsv"}));expect(c.state.destination).toBeNull();
});
it("复制失败保留窗口选项与可操作错误",async()=>{
  vi.mocked(copyTransfer).mockResolvedValue(false);act(()=>root.render(<Harness mode="copy"/>));act(()=>c.format("json"));
  await act(async()=>c.run());expect(c.state.error).toContain("改为文件导出");expect(c.state.options.format).toBe("json");
});
it("复制成功在窗口内给反馈，浮动通知被遮挡时仍知道输出已完成",async()=>{
  vi.mocked(copyTransfer).mockResolvedValue(true);act(()=>root.render(<Harness mode="copy"/>));await act(async()=>c.run());
  expect(c.state.notice).toBe("已复制 1 行 × 1 列 · TSV");expect(c.state.busy).toBe("");
});
it("UPDATE预览不因长原键被截断而伪造键更新",()=>{
  const key="K".repeat(400),options={...defaultTransferOptions("update"),table:"T",keys:[0],keysConfirmed:true,columnIndices:[0,1]};
  const data={columns:frame.data.columns,rows:[[key,"新值"]],originalRows:[[key,"原值"]]};
  act(()=>root.render(<TransferPreview data={data} options={options} order={[0,1]} onColumns={()=>{}} onMove={()=>{}} query={false}/>));
  const text=host.querySelector("pre")!.textContent!;expect(text).toContain("SET NAME = '新值'");expect(text).not.toContain("SET ID");expect(text).toContain(key);
});
it("真实窗口提供范围、固定底栏、预览、禁用空选区与只读过程重查",()=>{
  const source={...frame.source,sql:"begin p; end;",canRequery:false};
  act(()=>root.render(<ResultTransferDialog frame={{...frame,selection:null,source}} mode="file" open onClose={()=>{}} onFile={()=>{}}/>));
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("导出查询结果");
  const radios=[...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];expect(radios[0].disabled).toBe(true);expect(radios[3].disabled).toBe(true);
  expect(document.querySelector(".dbx-transfer-foot")?.textContent).toContain("保存文件");expect(document.querySelector(".dbx-transfer-preview")?.textContent).toContain("前 10 行");
});
it("范围摘要、预览与主动作一致，切换格式不扩大选区",()=>{
  act(()=>root.render(<ResultTransferDialog frame={{...frame,source:{...frame.source,schema:"NC_FROZEN"}}} mode="file" open onClose={()=>{}} onFile={()=>{}}/>));
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector(".dbx-transfer-head")?.textContent).toContain("NC_FROZEN");
  const summary=()=>[".dbx-transfer-range strong",".dbx-transfer-preview-scope",".dbx-transfer-summary strong"].map(selector=>dialog.querySelector(selector)?.textContent);
  expect(summary()).toEqual(Array(3).fill("当前选区 · 1 行 × 1 列"));
  const format=dialog.querySelector<HTMLSelectElement>('[aria-label="输出格式"]')!;
  for(const value of ["csv","json","markdown","html","insert","where","update","tsv","jsonl","xlsx"]){
    act(()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(format,value);format.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(summary()).toEqual(Array(3).fill("当前选区 · 1 行 × 1 列"));
    expect([...dialog.querySelectorAll<HTMLInputElement>('.dbx-transfer-col input:checked')]).toHaveLength(1);
    const action=dialog.querySelector<HTMLButtonElement>(".dbx-transfer-foot-actions .pri")!;
    expect(document.getElementById(action.getAttribute("aria-describedby")!)?.textContent).toBe("当前选区 · 1 行 × 1 列");
  }
  const scopes=[...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  act(()=>scopes[2].click());
  expect(summary()).toEqual(Array(3).fill("已加载全部行 · 2 行 × 1 列"));
  act(()=>scopes[3].click());
  expect(summary()).toEqual(Array(3).fill("重新查询导出全部 · 总行数未知 × 1 列"));
  expect(dialog.querySelector(".dbx-transfer-preview")?.textContent).toContain("当前结果样本");
});
it("折叠的字段设置可展开修改，Esc 关闭后归还触发点焦点",async()=>{
  vi.useFakeTimers();
  function Window(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>打开输出</button><ResultTransferDialog frame={frame} mode="file" open={open} onClose={()=>setOpen(false)} onFile={()=>{}}/></>;}
  act(()=>root.render(<Window/>));
  const trigger=host.querySelector<HTMLButtonElement>("button")!;trigger.focus();act(()=>trigger.click());
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!;
  const fields=dialog.querySelector<HTMLDetailsElement>(".dbx-transfer-column-settings")!;
  expect(fields).not.toBeNull();expect(fields.open).toBe(false);
  const toggle=fields.querySelector<HTMLElement>("summary")!;
  act(()=>toggle.click());expect(fields.open).toBe(true);
  const id=[...fields.querySelectorAll<HTMLElement>(".dbx-transfer-col")].find(row=>row.querySelector("code")?.textContent==="ID")!;
  act(()=>id.querySelector<HTMLInputElement>("input")!.click());
  expect(dialog.querySelector(".dbx-transfer-range strong")?.textContent).toBe("当前选区 · 1 行 × 2 列");
  act(()=>id.querySelector<HTMLButtonElement>('[aria-label="上移 ID"]')!.click());
  expect([...dialog.querySelectorAll(".dbx-transfer-preview-data th")].map(cell=>cell.textContent)).toEqual(["ID","NAME"]);
  const advanced=dialog.querySelector<HTMLDetailsElement>(".dbx-transfer-advanced")!;
  expect(advanced.open).toBe(false);act(()=>advanced.querySelector<HTMLElement>("summary")!.click());expect(advanced.open).toBe(true);
  const values=advanced.querySelector<HTMLSelectElement>('[aria-label="输出值来源"]')!;expect(values.disabled).toBe(false);
  toggle.focus();act(()=>toggle.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  await act(async()=>{vi.advanceTimersByTime(500);});
  expect(document.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(trigger);
});
it("两个保留中的输出窗口使用独立的原生范围单选组",()=>{
  act(()=>root.render(<><ResultTransferDialog frame={frame} mode="copy" open onClose={()=>{}} onFile={()=>{}}/><ResultTransferDialog frame={frame} mode="file" open onClose={()=>{}} onFile={()=>{}}/></>));
  const dialogs=[...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const groups=dialogs.map(dialog=>[...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')]);
  expect(groups[0]).toHaveLength(4);expect(groups[1]).toHaveLength(4);
  expect(new Set(groups[0].map(radio=>radio.name)).size).toBe(1);
  expect(groups[0][0].name).not.toBe(groups[1][0].name);
  act(()=>groups[1][2].click());expect(groups[0][0].checked).toBe(true);expect(groups[1][2].checked).toBe(true);
});
it("重查询范围显示冻结来源不匹配的原因，已加载范围仍可输出",()=>{
  act(()=>root.render(<ResultTransferDialog frame={{...frame,source:{...frame.source,connectionKey:"previous-target"}}} mode="file" open onClose={()=>{}} onFile={()=>{}}/>));
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!;
  const requery=dialog.querySelector<HTMLInputElement>('input[type="radio"][value="query"]')!;
  expect(requery.disabled).toBe(true);expect(requery.closest("label")?.textContent).toContain("连接目标已变化");
  expect(dialog.querySelector<HTMLButtonElement>(".dbx-transfer-foot-actions .pri")!.disabled).toBe(false);
});
