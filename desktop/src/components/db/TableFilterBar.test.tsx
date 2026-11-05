// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TableFilterBar } from "./TableFilterBar";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("收起保留草稿、摘要和查询入口", async () => {
  localStorage.clear();
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const apply=vi.fn();
  const button=(name:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===name)!;
  try {
    await act(async()=>root.render(<TableFilterBar connId="test" table="TEST" cols={[]} disabled={false} onApply={apply}/>));
    expect(host.querySelector<HTMLElement>('.dbx-filter-body')!.hidden).toBe(true);
    await act(async()=>button('查询').click());expect(apply).toHaveBeenCalledOnce();
    await act(async()=>button('展开筛选').click());
    await act(async()=>button('手写 WHERE').click());
    const input=host.querySelector<HTMLInputElement>('input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'CODE = 1');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>button('收起筛选').click());
    expect(host.querySelector('.dbx-filter-summary')!.textContent).toContain('CODE = 1');
    await act(async()=>button('查询').click());expect(apply).toHaveBeenLastCalledWith('CODE = 1','',[]);
    await act(async()=>button('展开筛选').click());expect(input.value).toBe('CODE = 1');
  } finally {await act(async()=>root.unmount());host.remove();}
});
