// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CellDetail } from "./CellDetail";
import { copyText } from "../../lib/utils";

// 部分 mock：放大后详情住进 Modal，它的焦点陷阱要用 isImeComposing 等真实工具函数，
// 全量替换成只有 copyText 会让 Esc 这条路在 jsdom 里炸掉。
vi.mock("../../lib/utils", async original => ({ ...await original<typeof import("../../lib/utils")>(), copyText: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
HTMLElement.prototype.scrollIntoView=vi.fn();
let host:HTMLDivElement,root:Root;
const column={name:"CONTENT",type:"CLOB",precision:0,scale:0};
beforeEach(()=>{vi.clearAllMocks();host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
/** 放大后整块搬到 Modal（portal 挂 body），按钮就不在 host 里了。 */
const docButton=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;

it("LONG RAW 默认显示可读预览，加载后格式化 JSON，原值仍可复制", async () => {
  const preview = "7B226E616D65223A22E789A9E69699…";
  const full = "7B226E616D65223A22E789A9E69699227D";
  const load = vi.fn().mockResolvedValue({ value: full, chars: full.length, truncated: false });
  act(() => root.render(<CellDetail column={{ ...column, type: "LONG RAW" }} row={1} value={preview} empty={false} lob={{ canLoad: true, load }} onClose={() => {}} />));
  expect(host.querySelector("pre")?.textContent).toContain('{"name":"物料');
  expect(host.querySelector(".dbx-detail-status")?.textContent).toContain("预览 · UTF-8");
  expect(host.querySelector(".dbx-detail-status button")?.textContent).toBe("加载完整值");
  await act(async () => { button("加载完整值").click(); });
  expect(load).toHaveBeenCalledOnce();
  expect(host.querySelector("pre")?.textContent).toContain('"name": "物料"');
  act(() => button("复制原值").click());
  expect(vi.mocked(copyText).mock.calls[0][0]).toBe(full);
});

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

/**
 * 340px 侧栏读一千多字的报错堆栈太窄，所以给一个「放大」。
 * 两层 Esc 是刻意的：先退出放大（回到侧栏），再关详情——一次 Esc 直接关掉
 * 会让人以为整个详情没了，得重新按 F4。
 */
it("放大到独立大窗：内容与按钮都还在，Esc 先退回侧栏再关详情", () => {
  const close = vi.fn();
  const value = "反馈传输数据失败！".repeat(80);
  act(()=>root.render(<CellDetail column={column} row={1} value={value} empty={false} onClose={close} />));
  act(()=>button("放大").click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector("pre")?.textContent).toBe(value);
  expect(document.querySelector(".dbx-detail")?.getAttribute("data-expanded")).toBe("true");
  const event=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
  act(()=>document.querySelector("pre")!.dispatchEvent(event));
  // 第一层 Esc 只退回侧栏：详情还在，onClose 一次都没走
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector(".dbx-detail")).not.toBeNull();
  act(()=>button("放大").click());
  act(()=>docButton("复制原值").click());
  expect(vi.mocked(copyText).mock.calls[0][0]).toBe(value);
  act(()=>docButton("退回侧栏").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector(".dbx-detail")).not.toBeNull();
});
