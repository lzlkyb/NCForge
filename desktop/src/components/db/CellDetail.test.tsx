// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CellDetail } from "./CellDetail";
import { copyText } from "../../lib/utils";

vi.mock("../../lib/utils",()=>({copyText:vi.fn()}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
HTMLElement.prototype.scrollIntoView=vi.fn();
let host:HTMLDivElement,root:Root;
const column={name:"CONTENT",type:"CLOB",precision:0,scale:0};
beforeEach(()=>{vi.clearAllMocks();host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;

it("完整长值可聚焦阅读，JSON 格式化只影响显示，复制始终保留原值",()=>{
  const value=` {"raw":"${"x".repeat(20000)}", "n":1}\n`;
  act(()=>root.render(<CellDetail column={column} row={1} value={value} empty={false} onClose={()=>{}} />));
  const content=host.querySelector<HTMLPreElement>("pre")!;
  expect(content.textContent).toBe(value);
  expect(document.activeElement).toBe(content);
  act(()=>button("JSON 格式化").click());
  expect(button("JSON 格式化").getAttribute("aria-pressed")).toBe("true");
  expect(content.textContent).toBe(JSON.stringify(JSON.parse(value),null,2));
  act(()=>button("复制原值").click());
  expect(vi.mocked(copyText).mock.calls[0][0]).toBe(value);
});

it("NULL、空串、空白及普通波浪号区分展示，空白可视化不改变复制内容",()=>{
  const render=(value:string|null)=>act(()=>root.render(<CellDetail column={column} row={1} value={value} empty={false} onClose={()=>{}} />));
  render(null);expect(host.textContent).toContain("NULL");expect(button("复制原值").disabled).toBe(true);
  render("");expect(host.textContent).toContain("空字符串");expect(button("复制原值").disabled).toBe(false);
  expect(host.querySelector("pre")?.textContent).toBe("");
  act(()=>button("复制原值").click());expect(vi.mocked(copyText).mock.calls[0][0]).toBe("");
  const whitespace=" \t\r\n ";render(whitespace);expect(host.textContent).toContain("仅空白字符");
  act(()=>button("显示空白").click());expect(host.querySelector("pre")?.textContent).not.toBe(whitespace);
  act(()=>button("复制原值").click());expect(vi.mocked(copyText).mock.calls[1][0]).toBe(whitespace);
  render("~");expect(host.querySelector("pre")?.textContent).toBe("~");expect(host.textContent).not.toContain("仅空白字符");
});

it("Esc 与关闭按钮走同一个关闭回调，切换值不会继续冒充格式化视图",()=>{
  const close=vi.fn();
  const render=(value:string)=>act(()=>root.render(<CellDetail column={column} row={1} value={value} empty={false} onClose={close} />));
  render('{"ok":true}');act(()=>button("JSON 格式化").click());
  render("新的原始值");expect(button("JSON 格式化").getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector("pre")?.textContent).toBe("新的原始值");
  const event=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
  act(()=>host.querySelector("pre")!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);expect(close).toHaveBeenCalledTimes(1);
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click());
  expect(close).toHaveBeenCalledTimes(2);
});
