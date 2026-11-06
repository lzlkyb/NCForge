// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyUiDensity } from "../../lib/uiDensity";
import type { Selection } from "../../lib/dbResultTools";
import type { Cell } from "../../lib/dbApi";
import { ResultGrid } from "./ResultGrid";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
HTMLElement.prototype.scrollTo = () => {};
const columns=[{name:"ID",type:"NUMBER",precision:10,scale:0},{name:"NAME",type:"VARCHAR2",precision:50,scale:0}];
const rows=Array.from({length:2000},(_,i)=>[i,`名称 ${i}`]);
const order=rows.map((_,i)=>i);
let root:Root, host:HTMLDivElement;
beforeEach(()=>{applyUiDensity("standard");host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
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
  expect(grid.scrollTop).toBe(521*30-200+44);
  act(()=>grid.dispatchEvent(new Event("scroll",{bubbles:true})));
  expect(host.querySelector('#dbx-cell-520-1')?.getAttribute('aria-selected')).toBe("true");
  act(()=>applyUiDensity("standard"));
  expect(grid.scrollTop).toBeCloseTo((521*30-200+44)/30*26);
  expect(host.querySelector('#dbx-cell-520-1')?.getAttribute('aria-selected')).toBe("true");
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
