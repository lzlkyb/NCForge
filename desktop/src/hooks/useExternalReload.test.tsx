// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tabs: [] as { path: string }[], dirty: new Set<string>() }));
vi.mock("../lib/workspaceSession", () => ({ getSession: () => ({ tabs: mocks.tabs, root: "D:/p" }) }));
vi.mock("../lib/editorStore", () => ({ isModelDirty: (p: string) => mocks.dirty.has(p) }));
vi.mock("../lib/appConfig", () => ({ autoCompileCached: () => false, autoExternalCached: () => false }));
vi.mock("../lib/autoCompile", () => ({ isJavaFile: (p: string) => p.endsWith(".java"), isAutoCompileTarget: () => false }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));
import { useExternalReload } from "./useExternalReload";
import { handleExternalJavaChanges } from "../lib/externalJavaChanges";
import { markLocalSave, resetLocalSaves } from "../lib/localSaves";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reload = vi.fn(async (_p: string) => {});
function Harness() {
  useExternalReload(reload);
  return null;
}
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

beforeEach(() => {
  reload.mockClear();
  mocks.tabs = [{ path: "D:/p/m/src/A.java" }, { path: "D:/p/m/src/B.java" }];
  mocks.dirty = new Set();
  resetLocalSaves();
});

describe("外部改动自动刷新已打开标签", () => {
  it("没有未保存修改的标签重新加载，路径大小写/斜杠不同也认", async () => {
    const off = await mount();
    handleExternalJavaChanges(["d:\\P\\m\\src\\A.java"], false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("D:/p/m/src/A.java");
    await off();
  });

  it("有未保存修改的标签不动（交给保存时的冲突检测）", async () => {
    const off = await mount();
    mocks.dirty.add("D:/p/m/src/A.java");
    handleExternalJavaChanges(["D:/p/m/src/A.java", "D:/p/m/src/B.java"], false);
    expect(reload.mock.calls.map((c) => c[0])).toEqual(["D:/p/m/src/B.java"]);
    await off();
  });

  it("没打开的文件、非 .java、本应用刚保存的文件都不触发", async () => {
    const off = await mount();
    markLocalSave("D:/p/m/src/A.java");
    handleExternalJavaChanges(["D:/p/m/src/Other.java", "D:/p/m/src/A.java", "D:/p/m/src/B.xml"], false);
    expect(reload).not.toHaveBeenCalled();
    await off();
  });

  it("关掉自动编译也照样刷新标签（两件事互不相干）", async () => {
    const off = await mount();
    handleExternalJavaChanges(["D:/p/m/src/B.java"], false);
    expect(reload).toHaveBeenCalledTimes(1);
    await off();
  });

  it("卸载后不再响应", async () => {
    const off = await mount();
    await off();
    handleExternalJavaChanges(["D:/p/m/src/B.java"], false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("审查通道里的非 .java 文本改动也刷新对应标签", async () => {
    const off = await mount();
    mocks.tabs = [{ path: "D:/p/m/src/A.java" }, { path: "D:/p/m/mapper/B.xml" }];
    // 后端把 .xml 内容改动放进 reviewChanged：编辑器里打开的 .xml 也得跟着磁盘变
    handleExternalJavaChanges(["D:/p/m/src/A.java"], false, ["D:/p/m/mapper/B.xml"], false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("D:/p/m/mapper/B.xml");
    await off();
  });
});
