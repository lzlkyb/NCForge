// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { copyTransfer, serializeTransferAsync } from "./resultTransferClipboard";
import { defaultTransferOptions } from "./resultTransfer";
vi.mock("./operations",()=>({beginOperation:()=>({finish:vi.fn()})}));
vi.mock("./dbOperations",()=>({dbTaskSpec:()=>({})}));
vi.mock("../components/ui/toast",()=>({toast:vi.fn()}));
const source={connId:"c",resultId:"r",sql:"select * from T",source:"测试",complete:true};
const column={name:"VALUE",type:"VARCHAR2",precision:80,scale:0};
let writeText:ReturnType<typeof vi.fn>,write:ReturnType<typeof vi.fn>;
beforeEach(()=>{writeText=vi.fn().mockResolvedValue(undefined);write=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText,write}});vi.unstubAllGlobals();});
it("单格原始复制不注入表格前缀且保留换行及前导零",async()=>{
  const options={...defaultTransferOptions(),columnIndices:[0],header:"none" as const};
  expect(await copyTransfer({columns:[column],rows:[["0012\t第一行\n第二行"]]},options,source,true)).toBe(true);
  expect(writeText).toHaveBeenCalledWith("0012\t第一行\n第二行");
});
it("HTML同时提供富文本与源码，并拒绝业务值成为HTML标记",async()=>{
  const constructor=vi.fn();vi.stubGlobal("ClipboardItem",class{constructor(value:unknown){constructor(value);}});
  expect(await copyTransfer({columns:[column],rows:[["<script>失败</script>"]]},defaultTransferOptions("html"),source)).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);expect(writeText).not.toHaveBeenCalled();
  const values=constructor.mock.calls[0][0];expect(Object.keys(values)).toEqual(["text/html","text/plain"]);expect(values["text/html"].type).toBe("text/html");
});
it("5MiB以上先拒绝复制并保持剪贴板，失败不宣称成功",async()=>{
  const options={...defaultTransferOptions("json"),columnIndices:[0]};
  expect(await copyTransfer({columns:[column],rows:[["字".repeat(2*1024*1024)]]},options,source)).toBe(false);expect(writeText).not.toHaveBeenCalled();
  writeText.mockRejectedValue(Error("权限拒绝"));expect(await copyTransfer({columns:[column],rows:[["内容"]]},options,source)).toBe(false);
});
it("默认全部列走Worker，分批且不克隆无关列值",async()=>{
  const messages:Record<string,unknown>[]=[];const terminate=vi.fn();
  vi.stubGlobal("Worker",class {
    onmessage:((event:{data:{text:string}})=>void)|null=null;
    terminate=terminate;
    postMessage(message:Record<string,unknown>){messages.push(message);if(message.kind==="serialize")this.onmessage?.({data:{text:"done"}});}
  });
  const columns=Array.from({length:4},(_,i)=>({...column,name:`C${i}`}));
  const rows=Array.from({length:600},()=>["a","b","c","d"]);
  expect(await serializeTransferAsync({columns,rows},defaultTransferOptions())).toBe("done");
  expect(messages.filter(m=>m.kind==="rows")).toHaveLength(5);
  expect((messages.find(m=>m.kind==="init")?.data as {rows:unknown[]}).rows).toEqual([]);
  expect(terminate).toHaveBeenCalledTimes(1);
  messages.length=0;
  const large=Array.from({length:2200},()=>["a","not copied","key","not copied"]);
  await serializeTransferAsync({columns,rows:large},{...defaultTransferOptions(),columnIndices:[0],keys:[2]});
  const chunk=messages.find(m=>m.kind==="rows")!.rows as unknown[][];
  expect(chunk[0]).toEqual(["a",null,"key",null]);
  expect(chunk.length).toBeLessThanOrEqual(128);
});
