// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyUiDensity } from "../../lib/uiDensity";
import type { Selection } from "../../lib/dbResultTools";
import type { Cell } from "../../lib/dbApi";
import { ResultGrid, type ResultGridApi } from "./ResultGrid";
import { ContextMenu } from "../workspace/ContextMenu";
import { copyText } from "../../lib/utils";

vi.mock("../../lib/utils", async original => ({ ...await original<typeof import("../../lib/utils")>(), copyText: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
HTMLElement.prototype.scrollTo = () => {};
HTMLElement.prototype.scrollIntoView = vi.fn();
const columns=[{name:"ID",type:"NUMBER",precision:10,scale:0},{name:"NAME",type:"VARCHAR2",precision:50,scale:0}];
const rows=Array.from({length:2000},(_,i)=>[i,`名称 ${i}`]);
const order=rows.map((_,i)=>i);
let root:Root, host:HTMLDivElement;
beforeEach(()=>{vi.clearAllMocks();applyUiDensity("standard");host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();applyUiDensity("standard");});

function Grid({edited=vi.fn()}:{edited?:(r:number,c:number,v:Cell)=>void}) {
  const [selection,setSelection]=useState<Selection|null>({anchor:{r:500,c:1},end:{r:500,c:1}});
  return <ResultGrid columns={columns} rows={rows} order={order} sort={null} onSort={()=>{}} sel={selection?.end ?? null} onSel={(p,extend)=>setSelection(s=>({anchor:extend && s ? s.anchor : p,end:p}))} selection={selection} visible={[0,1]} frozen={["ID"]} widthOverrides={{}} onWidths={()=>{}} edit={{canEdit:c=>c===1,changed:new Map(),onEdit:edited}} />;
}

it("切密度保持首行与选区，CSS 行高、虚拟位置、键盘滚动使用同一几何",()=>{
  act(()=>root.render(<Grid />));
  const grid=host.querySelector<HTMLDivElement>('[role="grid"]')!;
  Object.defineProperty(grid,"clientHeight",{value:200});
  Object.defineProperty(grid,"clientWidth",{value:400});
  act(()=>{grid.scrollTop=500*26;grid.dispatchEvent(new Event("scroll",{bubbles:true}));});
  expect(grid.style.getPropertyValue("--dbx-row-h")).toBe("26px");
  expect(host.querySelector<HTMLDivElement>('.dbx-grid-inner')!.style.height).toBe(`${40+2000*26}px`);
  expect(host.querySelectorAll('.dbx-grow').length).toBeLessThan(40);
  const firstIndex=host.querySelector('.dbx-grow')!.getAttribute('aria-rowindex');
  act(()=>applyUiDensity("comfortable"));
  expect(grid.scrollTop).toBe(500*30);
  expect(grid.style.getPropertyValue("--dbx-row-h")).toBe("30px");
  expect(grid.style.getPropertyValue("--dbx-head-h")).toBe("44px");
  expect(host.querySelector<HTMLDivElement>('.dbx-grid-inner')!.style.height).toBe(`${44+2000*30}px`);
  expect(host.querySelector('.dbx-grow')!.getAttribute('aria-rowindex')).toBe(firstIndex);
  expect(host.querySelector<HTMLDivElement>('[aria-rowindex="502"]')!.style.top).toBe(`${44+500*30}px`);
  expect(host.querySelector('#dbx-cell-500-1')?.getAttribute('aria-selected')).toBe("true");
  act(()=>grid.dispatchEvent(new KeyboardEvent("keydown",{key:"PageDown",bubbles:true})));
  // PageDown 按一屏能放几行翻页：clientHeight 200 / 行高 30 → 5 行（不再写死 20）
  expect(grid.scrollTop).toBe(506*30-200+44);
  act(()=>grid.dispatchEvent(new Event("scroll",{bubbles:true})));
  expect(host.querySelector('#dbx-cell-505-1')?.getAttribute('aria-selected')).toBe("true");
  act(()=>applyUiDensity("standard"));
  expect(grid.scrollTop).toBeCloseTo((506*30-200+44)/30*26);
  expect(host.querySelector('#dbx-cell-505-1')?.getAttribute('aria-selected')).toBe("true");
});

it("舒适密度的编辑与冻结列不改变原始行列定位，Esc 不写入",()=>{
  applyUiDensity("comfortable");const edited=vi.fn();
  act(()=>root.render(<Grid edited={edited} />));
  const grid=host.querySelector<HTMLDivElement>('[role="grid"]')!;
  act(()=>{grid.scrollTop=500*30;grid.dispatchEvent(new Event("scroll",{bubbles:true}));});
  expect(host.querySelector<HTMLDivElement>('#dbx-cell-500-0')!.style.position).toBe("sticky");
  act(()=>grid.dispatchEvent(new KeyboardEvent("keydown",{key:"F2",bubbles:true})));
  const input=host.querySelector<HTMLInputElement>('.dbx-gedit')!;
  expect(input.value).toBe("名称 500");
  act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  expect(host.querySelector('.dbx-gedit')).toBeNull();
  expect(edited).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(grid);
});

it("虚拟范围仅绘制逻辑外周，活动格、冻结列、修改值和 NULL 各自保留语义",()=>{
  const cols=Array.from({length:100},(_,i)=>({name:`C${i}`,type:"VARCHAR2",precision:20,scale:0}));
  const data=Array.from({length:1000},()=>cols.map(()=>null));
  act(()=>root.render(<ResultGrid columns={cols} rows={data} order={data.map((_,i)=>i)} sort={null} onSort={()=>{}}
    sel={{r:900,c:90}} onSel={()=>{}} selection={{anchor:{r:0,c:0},end:{r:900,c:90}}}
    visible={cols.map((_,i)=>i)} frozen={["C0"]} widthOverrides={{}} onWidths={()=>{}}
    edit={{canEdit:()=>true,changed:new Map([["500:0","changed"]]),onEdit:()=>{}}} />));
  const grid=host.querySelector<HTMLDivElement>('[role="grid"]')!;
  Object.defineProperty(grid,"clientHeight",{value:200});Object.defineProperty(grid,"clientWidth",{value:400});
  act(()=>{grid.scrollTop=500*26;grid.scrollLeft=3000;grid.dispatchEvent(new Event("scroll",{bubbles:true}));});
  const changed=host.querySelector<HTMLDivElement>('#dbx-cell-500-0')!;
  expect(changed.classList.contains("chg")).toBe(true);
  expect(changed.style.position).toBe("sticky");
  expect(changed.style.background).toBe("");
  expect(changed.getAttribute("data-range-edges")).toBe("left");
  const interior=host.querySelector<HTMLDivElement>('[role="gridcell"][data-cell]:not([data-range-edges])')!;
  expect(interior).not.toBeNull();expect(interior.classList.contains("null")).toBe(true);
  expect(grid.getAttribute("aria-activedescendant")).toBeNull();
  expect(host.querySelector('[role="rowheader"][data-range-heading]')).not.toBeNull();
});

function key(el: Element, value: string, options: KeyboardEventInit = {}) {
  act(()=>el.dispatchEvent(new KeyboardEvent("keydown",{key:value,bubbles:true,cancelable:true,...options})));
}

it("表头提供单一 Tab 入口，键盘排序和菜单关闭后回到原表头",()=>{
  const sorted=vi.fn(), selected=vi.fn();
  function Headers() {
    const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
    return <><ResultGrid columns={columns} rows={rows} order={order} sort={null} onSort={sorted}
      onHeaderMenu={(_c,x,y)=>setMenu({x,y})} sel={{r:0,c:1}} onSel={selected}
      selection={{anchor:{r:0,c:1},end:{r:0,c:1}}} visible={[0,1]} frozen={[]} widthOverrides={{}} onWidths={()=>{}} />
      {menu && <ContextMenu {...menu} items={[{label:"重排并重查",onSelect:()=>{}}]} onClose={()=>setMenu(null)} />}</>;
  }
  act(()=>root.render(<Headers />));
  const grid=host.querySelector<HTMLElement>('[role="grid"]')!;
  const headers=()=>[...host.querySelectorAll<HTMLButtonElement>('.dbx-header-action')];
  expect(headers().filter(h=>h.tabIndex===0)).toHaveLength(1);
  act(()=>grid.focus());key(grid,"ArrowUp",{altKey:true});
  expect(document.activeElement).toBe(headers()[1]);
  key(document.activeElement!,"Enter");expect(sorted).toHaveBeenLastCalledWith(1);
  key(document.activeElement!,"F10",{shiftKey:true});
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  key(document.activeElement!,"Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(headers()[1]);
  key(document.activeElement!,"ContextMenu");
  act(()=>document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(headers()[1]);
  expect(sorted).toHaveBeenCalledTimes(1);
  key(document.activeElement!,"Home");expect(document.activeElement).toBe(headers()[0]);
  key(document.activeElement!,"ArrowDown");expect(document.activeElement).toBe(grid);
  expect(selected).toHaveBeenLastCalledWith({r:0,c:0});
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("键盘跨虚拟列会显露目标，Esc 保持原绝对选区，focusActive 恢复被滚出视口的格子",()=>{
  const cols=Array.from({length:60},(_,i)=>({name:`C${i}`,type:"VARCHAR2",precision:20,scale:0}));
  const data=Array.from({length:600},(_,r)=>cols.map((_,c)=>`${r}:${c}`));
  const visible=[0,40,2,55], widths=Object.fromEntries(cols.map(c=>[c.name,180]));
  const api=createRef<ResultGridApi>();
  function VirtualGrid() {
    const [selection,setSelection]=useState<Selection>({anchor:{r:500,c:40},end:{r:500,c:40}});
    return <ResultGrid apiRef={api} columns={cols} rows={data} order={data.map((_,i)=>599-i)} sort={null} onSort={()=>{}}
      sel={selection.end} onSel={(p,extend)=>setSelection(s=>({anchor:extend?s.anchor:p,end:p}))} selection={selection}
      visible={visible} frozen={["C0"]} widthOverrides={widths} onWidths={()=>{}} />;
  }
  act(()=>root.render(<VirtualGrid />));
  const grid=host.querySelector<HTMLDivElement>('[role="grid"]')!;
  Object.defineProperty(grid,"clientHeight",{value:200});Object.defineProperty(grid,"clientWidth",{value:320});
  act(()=>api.current!.focusActive());
  expect(document.activeElement).toBe(grid);
  expect(grid.getAttribute("aria-activedescendant")).toBe("dbx-cell-500-40");
  expect(host.querySelector('#dbx-cell-500-40')?.getAttribute("data-active-cell")).not.toBeNull();
  key(grid,"ArrowUp",{altKey:true});key(document.activeElement!,"End");
  expect(document.activeElement?.getAttribute("data-column")).toBe("55");
  expect(grid.scrollLeft).toBeGreaterThan(180);
  key(document.activeElement!,"Escape");
  expect(document.activeElement).toBe(grid);
  expect(grid.getAttribute("aria-activedescendant")).toBe("dbx-cell-500-40");
  key(grid,"ArrowDown",{shiftKey:true});
  expect(host.querySelector('#dbx-cell-499-40')?.getAttribute("aria-selected")).toBe("true");
  act(()=>{grid.scrollTop=0;grid.scrollLeft=0;grid.dispatchEvent(new Event("scroll",{bubbles:true}));});
  expect(grid.getAttribute("aria-activedescendant")).toBeNull();
  act(()=>api.current!.focusActive());
  expect(grid.getAttribute("aria-activedescendant")).toBe("dbx-cell-499-40");
  expect(host.querySelectorAll('.dbx-grow').length).toBeLessThan(40);
});

it("Menu 键使用活动格的原始索引，空字符串和空白的展示不污染复制值",()=>{
  const data:Cell[][]=[[null,""],["~"," \t\n"]], copied=vi.mocked(copyText), menu=vi.fn();
  function Values() {
    const [selection,setSelection]=useState<Selection>({anchor:{r:1,c:1},end:{r:1,c:1}});
    return <ResultGrid columns={columns} rows={data} order={[1,0]} sort={null} onSort={()=>{}} onCellMenu={menu}
      sel={selection.end} onSel={p=>setSelection({anchor:p,end:p})} selection={selection}
      visible={[1,0]} frozen={[]} widthOverrides={{}} onWidths={()=>{}} />;
  }
  act(()=>root.render(<Values />));
  const grid=host.querySelector<HTMLElement>('[role="grid"]')!;
  expect(host.querySelector('#dbx-cell-0-0')?.getAttribute("data-value-kind")).toBe("null");
  expect(host.querySelector('#dbx-cell-0-1')?.getAttribute("data-value-kind")).toBe("empty");
  expect(host.querySelector('#dbx-cell-1-1')?.getAttribute("data-value-kind")).toBe("whitespace");
  expect(host.querySelector('#dbx-cell-1-0')?.textContent).toBe("~");
  key(grid,"ContextMenu");expect(menu.mock.calls[0].slice(0,2)).toEqual([1,1]);
  key(grid,"c",{ctrlKey:true});
  expect(copied.mock.calls[0][0]).toContain(" \t\n");
  expect(copied.mock.calls[0][0]).not.toContain("空白");
  key(grid,"ArrowDown");key(grid,"c",{ctrlKey:true});
  expect(copied.mock.calls[1][0]).toBe("");
  expect(host.querySelector('#dbx-cell-0-1')?.textContent).toBe("");
});

it("列级解码：未开启时原样显示，开启后显示明文并出编码标记",()=>{
  const HEX='7b226f72674e6f223a22313030373839227d';
  const cols=[{name:"PK",type:"VARCHAR2",precision:20,scale:0},{name:"JSON",type:"CLOB",precision:0,scale:0}];
  const data=[["1",HEX],["2",HEX]];
  const render=(decoded?:string[])=>act(()=>root.render(
    <ResultGrid columns={cols} rows={data} order={[0,1]} sort={null} onSort={()=>{}} sel={null} onSel={()=>{}}
      selection={null} visible={[0,1]} frozen={[]} widthOverrides={{}} onWidths={()=>{}} decoded={decoded} />));
  render();
  expect(host.querySelector('#dbx-cell-0-1')?.textContent).toBe(HEX);
  // 抽样判定成编码列 ⇒ 列头出小圆点（空心），提示「右键可解码」
  expect(host.querySelector('.dbx-gh .dbx-codec')).toBeTruthy();
  expect(host.querySelector('.dbx-gh .dbx-codec')?.hasAttribute('data-on')).toBe(false);
  render(["JSON"]);
  expect(host.querySelector('#dbx-cell-0-1')?.textContent).toBe('{"orgNo":"100789"}');
  expect(host.querySelector('.dbx-gh .dbx-codec')?.hasAttribute('data-on')).toBe(true);
});
