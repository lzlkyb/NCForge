// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChangeList } from "./ChangeList";
import { SvnFileRows } from "./SvnFileRows";
import { getSvnDraft, syncSvnDraft } from "../../lib/svnDraft";
import { setSvnListPrefs } from "../../lib/svnListPrefs";
import { keyOf, type ChangeItem } from "../../lib/svn";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => dispose());
it("module selection preserves files in other modules and compares normalized paths", () => {
  const workspace = "C:/svn-module-selection";
  const items = ["A","B","Other"].map(name => ({path:`${workspace}/${name}.java`,rel:`${name}.java`,module:name === "Other" ? "other" : "m",letter:"M",status:"modified",revision:1,isDir:false,ignored:false} as ChangeItem));
  syncSvnDraft(workspace,items);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  const paint = (picked: ReadonlySet<string>) => act(() => root.render(<SvnFileRows group={{module:"m",items:items.slice(0,2)}} closed={false} onToggleGroup={vi.fn()} selected={null} reviewed={new Set()} picked={picked} root={workspace} busy={false} sort="path" onSelect={vi.fn()} />));
  paint(new Set(items.map(item => item.path.toUpperCase())));
  act(() => host.querySelector<HTMLInputElement>('[aria-label="选择模块 m"]')!.click());
  expect([...getSvnDraft(workspace).picked]).toEqual([items[2].path]);
  paint(getSvnDraft(workspace).picked);
  act(() => host.querySelector<HTMLInputElement>('[aria-label="选择模块 m"]')!.click());
  expect([...getSvnDraft(workspace).picked]).toEqual(items.map(item => item.path));
});
it("row Space chooses submission while arrow keys browse visible files", () => {
  const workspace = "C:/svn-list-ui", items = ["A","B"].map(name => ({path:`${workspace}/${name}.java`,rel:`${name}.java`,module:"m",letter:"M",status:"modified",revision:1,isDir:false,ignored:false} as ChangeItem));
  const host = document.createElement("div"), root = createRoot(host), select = vi.fn(); document.body.append(host);
  syncSvnDraft(workspace,items); setSvnListPrefs(workspace,{filter:"all",search:"",closed:[]});
  act(() => root.render(<ChangeList root={workspace} view={{groups:[{module:"m",items}],shown:2,total:2,ignored:0}} reviewed={new Set()} picked={getSvnDraft(workspace).picked} selected={items[0].path} loading={false} error={null} showIgnored={false} onToggleIgnored={vi.fn()} onSelect={select} />));
  dispose = () => { act(() => root.unmount()); host.remove(); };
  const rows = host.querySelectorAll<HTMLButtonElement>("[data-file-row]");
  act(() => { rows[0].focus(); rows[0].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); });
  expect(document.activeElement).toBe(rows[1]); expect(select).toHaveBeenCalledWith(items[1]);
  act(() => rows[1].dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true})));
  expect([...getSvnDraft(workspace).picked]).toEqual([items[0].path]);
});

it("需重审筛选只显示过期审查，重审后更新列表与数量", () => {
  const workspace = "C:/svn-outdated-ui";
  const items = ["A","B"].map(name => ({
    path:`${workspace}/${name}.java`,rel:`${name}.java`,module:"m",letter:"M",status:"modified",revision:1,isDir:false,ignored:false,
  } as ChangeItem));
  const view = { groups:[{ module:"m",items }], shown:2,total:2,ignored:0 };
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  const outdated = new Set([keyOf(items[0].path)]);
  const paint = (reviewed = new Set<string>()) => act(() => root.render(
    <ChangeList root={workspace} view={view} reviewed={reviewed} outdated={outdated} selected={null} loading={false}
      error={null} showIgnored={false} onToggleIgnored={vi.fn()} onSelect={vi.fn()} />,
  ));
  paint();
  const chip = [...host.querySelectorAll<HTMLButtonElement>(".vc-chip")].find(button => button.textContent === "需重审1")!;
  act(() => chip.click());
  expect([...host.querySelectorAll(".vc-fn")].map(row => row.textContent)).toEqual(["A.java"]);
  paint(new Set([keyOf(items[0].path)]));
  expect(host.querySelectorAll(".vc-fn")).toHaveLength(0);
  expect(chip.textContent).toBe("需重审0");
});
