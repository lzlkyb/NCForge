// @vitest-environment jsdom
import { act } from "react";
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
afterEach(()=>{act(()=>root.unmount());host.remove();});
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
