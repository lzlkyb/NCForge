// @vitest-environment jsdom
import { act, createRef } from "react";
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
    await act(async()=>button('查询整表').click());expect(apply).toHaveBeenCalledOnce();
    await act(async()=>button('更多筛选').click());
    await act(async()=>button('手写 WHERE').click());
    const input=host.querySelector<HTMLInputElement>('input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'CODE = 1');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>button('收起筛选').click());
    expect(host.querySelector('.dbx-filter-summary')!.textContent).toContain('CODE = 1');
    await act(async()=>button('查询整表').click());expect(apply).toHaveBeenLastCalledWith('CODE = 1','',[]);
    await act(async()=>button('更多筛选').click());expect(input.value).toBe('CODE = 1');
  } finally {await act(async()=>root.unmount());host.remove();}
});

it("快捷查询绑定单元格原值，只有查询返回的条件才可一键清除", async () => {
  localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<{ queryValue: (column: string, value: string | null) => void }>();
  const apply = vi.fn().mockResolvedValue(true);
  const empty = { where: "", order: "", params: [], page: 0 };
  const render = (query: NonNullable<Parameters<typeof TableFilterBar>[0]["appliedQuery"]>) =>
    act(async () => root.render(<TableFilterBar ref={ref} connId="test" table="TEST" filterScope="APP.TEST"
      cols={[{ name: "REGION", zh: "区域", type: "VARCHAR2" }, { name: "DR", type: "NUMBER" }] as never}
      appliedQuery={query} onApply={apply} disabled={false} />));
  try {
    await render(empty);
    await act(async () => ref.current!.queryValue("REGION", "O'Brien"));
    expect(apply).toHaveBeenLastCalledWith("(REGION = :1)", "", ["O'Brien"]);
    expect(host.querySelector(".dbx-applied-filter")).toBeNull();
    await render({ ...empty, where: "(REGION = :1)", params: ["O'Brien"] });
    const chip = host.querySelector<HTMLButtonElement>(".dbx-applied-filter")!;
    expect(chip.textContent).toBe("区域 = O'Brien ×");
    apply.mockResolvedValueOnce(false);
    await act(async () => chip.click());
    expect(host.querySelector(".dbx-applied-filter")?.textContent).toBe(chip.textContent);
    await act(async () => chip.click());
    expect(apply).toHaveBeenLastCalledWith("", "", []);
    await render(empty);
    expect(host.querySelector(".dbx-applied-filter")).toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "未删除")!.click());
    expect(apply).toHaveBeenLastCalledWith("(DR = :1)", "", [{ number: "0" }]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
