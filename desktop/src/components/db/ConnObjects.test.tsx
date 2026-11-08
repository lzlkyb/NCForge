// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({objects:vi.fn(),schema:"NC"}));
vi.mock("../../lib/dbApi",()=>({dbApi:{objects:mocks.objects}}));
vi.mock("../../lib/dbStore",()=>({useConnRt:()=>({status:"connected",currentSchema:mocks.schema,tables:[],ncNames:{}}),openTableTab:vi.fn()}));
vi.mock("../../lib/dbActions",()=>({newConsole:vi.fn(),openTable:vi.fn(),refreshMeta:vi.fn()}));
vi.mock("./ConnTableRow",()=>({FavStar:()=>null,TableRow:()=>null}));
import { ConnObjects } from "./ConnObjects";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("未展开其它对象时不查库，展开后复用结果，切 schema 才重读",async()=>{
  mocks.objects.mockReset();mocks.objects.mockResolvedValue({objects:[]});mocks.schema="NC";
  const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
  const paint=()=>root.render(<ConnObjects connId="c1" filter=""/>);
  const button=()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("其它对象"))!;
  try {
    await act(async()=>paint());expect(mocks.objects).not.toHaveBeenCalled();
    await act(async()=>button().click());expect(mocks.objects).toHaveBeenCalledTimes(1);
    await act(async()=>button().click());await act(async()=>button().click());expect(mocks.objects).toHaveBeenCalledTimes(1);
    mocks.schema="OTHER";await act(async()=>paint());expect(mocks.objects).toHaveBeenCalledTimes(2);
  }finally{await act(async()=>root.unmount());host.remove();}
});
