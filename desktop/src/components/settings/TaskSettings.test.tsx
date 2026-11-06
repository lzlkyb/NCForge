// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { workspace, addTask, loadTasks } = vi.hoisted(() => ({
  workspace: { root: "D:\\workspace" as string | null },
  addTask: vi.fn(),
  loadTasks: vi.fn(() => []),
}));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (s: { root: string | null }) => unknown) => selector(workspace) }));
vi.mock("../../lib/ncTasks", () => ({
  addTask, loadCustomTasks: loadTasks, removeTask: vi.fn(),
  BUILTIN_TASKS: [{ id: "builtin.compile", name: "编译全部", steps: ["compileAll"] }],
  STEP_LABELS: { compileAll: "编译全部模块", deploy: "投送元数据到 NC", restart: "重启 NC 服务" },
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
// 这一页会读一次配置（「保存时自动编译」开关的初值）：不 mock 的话会真去调 Tauri
vi.mock("../../lib/appConfig", () => ({
  getConfig: vi.fn(async () => ({ auto_compile: true })),
  patchConfig: vi.fn(async () => ({})),
  rememberAutoCompile: vi.fn(),
  rememberAutoIncremental: vi.fn(),
  rememberAutoExternal: vi.fn(),
}));
import { TaskSettings } from "./TaskSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  workspace.root = "D:\\workspace";
  addTask.mockReset();
  addTask.mockReturnValue({ ok: false, error: "本机存储写入失败" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<TaskSettings />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const name = () => container.querySelector<HTMLInputElement>("#task-name-input")!;
const enterName = async () => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name(), "日常编译");
    name().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
describe("任务渐进披露", () => {
  it("默认收起新建表单，关闭再展开保留输入", async () => {
    expect(container.querySelector<HTMLDetailsElement>(".settings-task-builtins")!.open).toBe(false);
    const details = container.querySelector<HTMLDetailsElement>("#task-new")!;
    expect(details.open).toBe(false);
    await act(async () => { details.open = true; });
    await enterName();
    await act(async () => { details.open = false; details.open = true; });
    expect(name().value).toBe("日常编译");
  });
  it("失败保留任务名与执行顺序，成功才清空并收起", async () => {
    const details = container.querySelector<HTMLDetailsElement>("#task-new")!;
    details.open = true;
    await enterName();
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => submit.click());
    expect(addTask).toHaveBeenCalledWith("D:\\workspace", "日常编译", ["compileAll", "deploy"]);
    expect(name().value).toBe("日常编译");
    expect(details.open).toBe(true);
    addTask.mockReturnValue({ ok: true, task: { name: "日常编译" } });
    await act(async () => submit.click());
    expect(name().value).toBe("");
    expect(details.open).toBe(false);
  });
  it("没有工作区时提供原因并禁用创建", async () => {
    workspace.root = null;
    await act(async () => root.render(<TaskSettings />));
    expect(name().disabled).toBe(true);
    expect(container.textContent).toContain("请先打开工程");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
});
