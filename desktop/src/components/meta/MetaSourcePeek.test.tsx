// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { MetaSourcePeek } from "./MetaSourcePeek";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const path = "D:/workspace/METADATA/demo.bmf";
beforeEach(() => {
  mocks.invoke.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}
const open = () => host.querySelector<HTMLButtonElement>(".meta-link")!;

it("查看前不取源码，点击才按基础文件 SHA 读取单个节点", async () => {
  mocks.invoke.mockResolvedValue('<entity id="head" />');
  await act(async () => root.render(<MetaSourcePeek path={path} id="head" sha="base" />));
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () => open().click());
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("bmf_node_source", { path, id: "head", expectedSha: "base" });
  expect(document.querySelector('[aria-label="节点原始 XML"]')?.textContent).toBe('<entity id="head" />');
});
it("详情已有节点原文时复用它，草稿期间不能读未保存节点", async () => {
  await act(async () => root.render(<MetaSourcePeek path={path} id="head" sha="base" raw="<entity />" />));
  await act(async () => open().click());
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="节点原始 XML"]')?.textContent).toBe("<entity />");
  await act(async () => root.render(<MetaSourcePeek path={path} id="new" sha="base" draft />));
  expect(open().disabled).toBe(true);
  await act(async () => open().click());
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="元数据原始 XML"]')).toBeNull();
});
it("关闭后或切对象后旧读取不会重新打开弹窗、串入新对象", async () => {
  const old = deferred(), next = deferred();
  mocks.invoke.mockImplementation((_cmd: string, args: { id: string }) => args.id === "head" ? old.promise : next.promise);
  await act(async () => root.render(<MetaSourcePeek path={path} id="head" sha="base" />));
  await act(async () => open().click());
  await act(async () => root.render(<MetaSourcePeek path={path} id="body" sha="base" />));
  await act(async () => open().click());
  await act(async () => old.resolve("OLD XML"));
  expect(document.body.textContent).not.toContain("OLD XML");
  await act(async () => next.resolve("BODY XML"));
  expect(document.querySelector('[aria-label="节点原始 XML"]')?.textContent).toBe("BODY XML");
  const pending = deferred(); mocks.invoke.mockReturnValue(pending.promise);
  await act(async () => root.render(<MetaSourcePeek path={path} id="another" sha="fresh" />));
  await act(async () => open().click());
  await act(async () => document.querySelector('[aria-label="元数据原始 XML"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => pending.resolve("LATE XML"));
  expect(document.querySelector('[aria-label="元数据原始 XML"]')).toBeNull();
});
it("源码冲突保留只读错误，重新读取使用同一基础 SHA", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("文件已被外部修改 SHA-256")).mockResolvedValueOnce("<current />");
  await act(async () => root.render(<MetaSourcePeek path={path} id="head" sha="base" />));
  await act(async () => open().click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("文件已被外部修改");
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "重试")!;
  await act(async () => retry.click());
  expect(document.querySelector('[aria-label="节点原始 XML"]')?.textContent).toBe("<current />");
  expect(mocks.invoke).toHaveBeenLastCalledWith("bmf_node_source", { path, id: "head", expectedSha: "base" });
});
