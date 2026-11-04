// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({objects:vi.fn()}));
vi.mock("../../lib/dbApi",()=>({dbApi:{objects:mock.objects},ENV_LABEL:{test:"测试"}}));
vi.mock("../../lib/dbStore",()=>{const S={conns:[{id:"c",name:"测试库",env:"test"}],tabs:[],active:null};const RT={status:"connected",tables:[],tablesAt:1};return {useDbConns:()=>S.conns,useDbSelector:(sel:(s:typeof S)=>unknown)=>sel(S),useConnRt:()=>RT,connOf:()=>({name:"测试库"})};});
vi.mock("../../lib/dbActions",()=>({newConsole:vi.fn(),openTable:vi.fn(),refreshMeta:vi.fn()}));
vi.mock("../../lib/dbConfirm",()=>({ensureConnected:vi.fn(async()=>true)}));
vi.mock("../ui/Modal",()=>({Modal:({children}:{children:ReactNode})=><section>{children}</section>}));
import { DbObjectFinder } from "./DbObjectFinder";
import { clearCompletedOperations, getOperations } from "../../lib/operations";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
afterEach(()=>{act(()=>root.unmount());host.remove();clearCompletedOperations();});
it("对象读取中不冒充空结果，失败能就地重新读取",async()=>{
  let reject!:(error:Error)=>void;mock.objects.mockReturnValueOnce(new Promise((_r,b)=>{reject=b;}));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(<DbObjectFinder connId="c" onClose={()=>{}}/>));
  expect(host.textContent).toContain("读取对象清单");expect(host.textContent).not.toContain("没有匹配对象");
  await act(async()=>reject(new Error("secret database error")));
  expect(host.textContent).toContain("对象清单读取失败");expect(JSON.stringify(getOperations().slice(-1)[0])).not.toContain("secret");
  mock.objects.mockResolvedValueOnce({objects:[{name:"TEST_PACKAGE",type:"PACKAGE"}]});
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="重新读取")!.click());
  expect(host.textContent).toContain("test_package");expect(host.textContent).not.toContain("对象清单读取失败");expect(mock.objects).toHaveBeenCalledTimes(2);
});
