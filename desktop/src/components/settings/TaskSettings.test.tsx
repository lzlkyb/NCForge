// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: { root: "D:/workspace" as string | null }, add: vi.fn(), update: vi.fn(), load: vi.fn(), remove: vi.fn() }));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (s: { root: string | null }) => unknown) => selector(mocks.workspace) }));
vi.mock("../../lib/ncTasks", () => ({ addTask: mocks.add, updateTask: mocks.update, loadCustomTasks: mocks.load, removeTask: mocks.remove,
  BUILTIN_TASKS: [{ id: "builtin.compile", name: "编译全部", steps: ["compileAll"] }],
  STEP_LABELS: { compileAll: "编译全部模块", deploy: "投送元数据到 NC", restart: "重启 NC 服务" } }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
import { TaskSettings } from "./TaskSettings";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
const field = () => host.querySelector<HTMLInputElement>("#task-name-input")!;
const render = () => act(async () => root.render(<TaskSettings />));
const type = async (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), text);
  field().dispatchEvent(new Event("input", { bubbles: true }));
});
beforeEach(async () => {
  vi.resetAllMocks(); mocks.workspace.root = "D:/workspace"; mocks.load.mockReturnValue([]);
  mocks.add.mockReturnValue({ ok: false, error: "本机存储写入失败" });
  mocks.update.mockReturnValue({ ok: true, task: { id: "custom.1", name: "已编辑" } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("任务流程编辑", () => {
  it("只调整步骤的未命名草稿也要确认后才能替换", async () => {
    await act(async () => button("新建任务").click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="上移投送元数据到 NC"]')!.click());
    await act(async () => button("新建任务").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "取消")!.click());
    expect(host.querySelector(".settings-task-ordered li")?.textContent).toContain("投送元数据");
  });
  it("保存失败保留名称与顺序，成功才收起并清空", async () => {
    await act(async () => button("新建任务").click()); await type("日常编译");
    await act(async () => button("添加任务").click());
    expect(mocks.add).toHaveBeenCalledWith("D:/workspace", "日常编译", ["compileAll", "deploy"]);
    expect(field().value).toBe("日常编译"); expect(host.textContent).toContain("本机存储写入失败");
    mocks.add.mockReturnValue({ ok: true, task: { name: "日常编译" } });
    await act(async () => button("添加任务").click()); expect(field().value).toBe(""); expect(host.querySelector<HTMLDetailsElement>("#task-new")!.open).toBe(false);
  });
  it("编号顺序可上下调整，已有任务可以编辑保存", async () => {
    mocks.load.mockReturnValue([{ id: "custom.1", name: "日常编译", steps: ["compileAll", "deploy"] }]); await render();
    await act(async () => button("编辑").click());
    const up = host.querySelector<HTMLButtonElement>('[aria-label="上移投送元数据到 NC"]')!;
    await act(async () => up.click());
    expect(host.querySelector(".settings-task-ordered li")?.textContent).toContain("投送元数据到 NC");
    await act(async () => button("保存任务").click());
    expect(mocks.update).toHaveBeenCalledWith("D:/workspace", "custom.1", "日常编译", ["deploy", "compileAll"]);
  });
  it("切换工作区保留各自草稿，不把旧任务保存到新工程", async () => {
    await act(async () => button("新建任务").click()); await type("A 的草稿");
    mocks.workspace.root = "E:/other"; await render(); expect(field().value).toBe("");
    await act(async () => button("新建任务").click()); await type("B 的草稿");
    mocks.workspace.root = "D:/workspace"; await render(); expect(field().value).toBe("A 的草稿");
    await act(async () => button("添加任务").click());
    expect(mocks.add).toHaveBeenLastCalledWith("D:/workspace", "A 的草稿", ["compileAll", "deploy"]);
  });
  it("没有工作区时说明原因并禁用创建", async () => {
    mocks.workspace.root = null; await render(); expect(field().disabled).toBe(true);
    expect(host.textContent).toContain("请先打开工程"); expect(button("添加任务").disabled).toBe(true);
  });
  it("收起保留的草稿再新建会先确认，取消不丢内容", async () => {
    await act(async () => button("新建任务").click()); await type("保留的草稿");
    await act(async () => button("收起并保留草稿").click());
    expect(host.querySelector<HTMLDetailsElement>("#task-new")!.open).toBe(false);
    await act(async () => button("新建任务").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "取消")!.click());
    expect(field().value).toBe("保留的草稿");
    await act(async () => button("新建任务").click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "放弃并继续")!.click());
    expect(field().value).toBe("");
    expect(host.querySelector<HTMLDetailsElement>("#task-new")!.open).toBe(true);
  });
});
