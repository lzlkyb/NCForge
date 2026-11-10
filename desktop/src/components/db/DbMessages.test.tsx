// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  conns: [{id:"a",name:"测试库"},{id:"b",name:"开发库"}],
  runtime: {} as Record<string, {status:string;error?:string}>,
  loadError: null as string | null,
  retry: vi.fn(), load: vi.fn(), edit: vi.fn(),
}));
vi.mock("../../lib/dbStore", () => ({
  useDbConns: () => mock.conns, useDbRt: () => mock.runtime,
  useDbSelector: (selector: (s: {loadError:string|null}) => unknown) => selector({loadError:mock.loadError}),
  loadConns: () => mock.load(), openConnDialog: (id:string) => mock.edit(id),
}));
vi.mock("../../lib/dbConfirm", () => ({ensureConnected:(id:string) => mock.retry(id)}));
import { DbMessages } from "./DbMessages";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host=document.createElement("div"); document.body.append(host); root=createRoot(host); mock.runtime={};mock.loadError=null;vi.clearAllMocks(); });
afterEach(() => {act(()=>root.unmount());host.remove();});
const render = () => act(()=>root.render(<DbMessages/>));
const button = (text:string) => [...host.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!;
it("所有失败连接集中展示，恢复和删除后自动清理", () => {
  mock.runtime={a:{status:"error",error:"TCP 超时"},b:{status:"error",error:"口令错误"}};
  render();
  expect(host.textContent).toContain("2 项待处理");
  expect(host.textContent).toContain("测试库");
  expect(host.textContent).toContain("暂时无法连接数据库");
  mock.runtime.a={status:"connected"};render();
  expect(host.textContent).not.toContain("TCP 超时");
  delete mock.runtime.b; render();
  expect(host.textContent).toBe("");
});
it("折叠保留消息计数，详情与设置可访问", () => {
  mock.runtime={a:{status:"error",error:"TCP 超时"}};render();
  expect(host.querySelector("details")?.textContent).toContain("TCP 超时");
  act(()=>button("连接设置").click());expect(mock.edit).toHaveBeenCalledWith("a");
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="收起数据库消息"]')!.click());
  expect(host.querySelector<HTMLElement>("#dbx-message-list")!.hidden).toBe(true);
  expect(host.textContent).toContain("1 项待处理");
});
it("连接重试指向正确连接", async () => {
  mock.runtime={b:{status:"error",error:"网络不可达"}}; render();
  await act(async()=>button("重新连接").click());expect(mock.retry).toHaveBeenCalledWith("b");
});
it("连接列表读取失败也走固定消息区", async () => {
  mock.loadError="文件读取失败";render();
  expect(host.textContent).toContain("连接列表暂时无法读取");
  await act(async()=>button("重试").click());expect(mock.load).toHaveBeenCalledTimes(1);
  mock.loadError=null;render();expect(host.textContent).toBe("");
});

it("网络问题优先重连，口令问题优先设置，诊断原文不丢失", () => {
  mock.runtime={a:{status:"error",error:"TCP 连接超时"}}; render();
  expect(host.querySelector(".dbx-message-actions .pri")?.textContent).toContain("重新连接");
  expect(host.querySelector(".dbx-message-text")?.textContent).toContain("VPN");
  expect(host.querySelector(".dbx-message-text")?.textContent).not.toContain("TCP");
  expect(host.querySelector("details")?.textContent).toContain("TCP 连接超时");
  mock.runtime.a.error="ORA-01017: invalid username/password";render();
  expect(host.querySelector(".dbx-message-actions .pri")?.textContent).toContain("连接设置");
});

it("重试期间运行态清除错误时，提示仍显示进度并防止重复提交", async () => {
  let done!: () => void;
  mock.retry.mockImplementationOnce(() => new Promise<void>(resolve => {done=resolve;}));
  mock.runtime={a:{status:"error",error:"TCP 超时"}};render();
  act(()=>button("重新连接").click());
  mock.runtime.a={status:"connecting"};render();
  expect(button("正在尝试").disabled).toBe(true);
  expect(mock.retry).toHaveBeenCalledTimes(1);
  mock.runtime.a={status:"connected"};
  await act(async()=>done());
  expect(host.textContent).toBe("");
});
