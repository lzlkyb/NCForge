// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabPersistence, useTabRestore, useTabSessionKeys } from "./useTabSession";
import { getSession, setSession, type TabMeta } from "../lib/workspaceSession";
import { readTabSnapshot, saveTabSnapshot } from "../lib/tabPersistence";
import { resetMru } from "../lib/tabMru";
import { emptyEditorGroups } from "../lib/editorGroups";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tab(path: string): TabMeta {
  return {
    path,
    name: path,
    encoding: "UTF-8",
    hasBom: false,
    eol: "CRLF",
    mtimeMs: 0,
    dirty: false,
    eolChanged: false,
    readOnly: false,
    readOnlyReason: null,
    lines: 1,
  };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  resetMru();
  document.body.innerHTML = "";
  setSession({ root: "C:\\w", tabs: [], activePath: null, splitPath: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function RestoreProbe({ rootPath, open }: { rootPath: string; open: (path: string) => Promise<boolean> }) {
  useTabRestore(rootPath, open);
  return null;
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("重启恢复标签", () => {
  it("按快照打开标签，并恢复激活项与分屏", async () => {
    const rootPath = "C:\\w\\restore-1";
    saveTabSnapshot(rootPath, {
      tabs: ["C:\\w\\A.java", "C:\\w\\B.java"],
      activePath: "C:\\w\\B.java",
      splitPath: "C:\\w\\A.java",
    });
    const open = vi.fn(async (path: string) => { setSession({ tabs: tabs => [...tabs, tab(path)] }); return true; });
    await act(async () => root.render(<RestoreProbe rootPath={rootPath} open={open} />));
    await flush();
    expect(open.mock.calls.map((c) => c[0])).toEqual(["C:\\w\\A.java", "C:\\w\\B.java"]);
    expect(getSession().activePath).toBe("C:\\w\\B.java");
    expect(getSession().splitPath).toBe("C:\\w\\A.java");
  });

  it("每个工作区只在一次运行里恢复一次", async () => {
    const rootPath = "C:\\w\\restore-2";
    saveTabSnapshot(rootPath, { tabs: ["C:\\w\\A.java"], activePath: "C:\\w\\A.java", splitPath: null });
    const open = vi.fn(async () => true);
    await act(async () => root.render(<RestoreProbe rootPath={rootPath} open={open} />));
    await flush();
    await act(async () => root.render(<RestoreProbe rootPath={rootPath} open={open} />));
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("已经有标签时不覆盖用户现场", async () => {
    const rootPath = "C:\\w\\restore-3";
    saveTabSnapshot(rootPath, { tabs: ["C:\\w\\A.java"], activePath: "C:\\w\\A.java", splitPath: null });
    setSession({ tabs: [tab("C:\\w\\already.java")] });
    const open = vi.fn(async () => true);
    await act(async () => root.render(<RestoreProbe rootPath={rootPath} open={open} />));
    await flush();
    expect(open).not.toHaveBeenCalled();
  });
});

function PersistProbe({ rootPath, tabs, activePath, splitPath }: {
  rootPath: string; tabs: TabMeta[]; activePath: string | null; splitPath: string | null;
}) {
  useTabPersistence(rootPath, tabs, activePath, splitPath);
  return null;
}

describe("标签快照落盘", () => {
  it("防抖后写入当前标签 / 激活项 / 分屏", async () => {
    const rootPath = "C:\\w\\persist-1";
    const tabs = [tab("C:\\w\\A.java"), tab("C:\\w\\B.java")];
    await act(async () => root.render(
      <PersistProbe rootPath={rootPath} tabs={tabs} activePath={"C:\\w\\B.java"} splitPath={"C:\\w\\A.java"} />,
    ));
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    expect(readTabSnapshot(rootPath)).toEqual({
      tabs: ["C:\\w\\A.java", "C:\\w\\B.java"],
      activePath: "C:\\w\\B.java",
      splitPath: "C:\\w\\A.java",
    });
  });
});

function KeysProbe({ tabs, activePath, reopenLast }: {
  tabs: TabMeta[]; activePath: string | null; reopenLast: () => Promise<boolean>;
}) {
  useTabSessionKeys(tabs, activePath, { reopenLast, selectTab: path => setSession({ activePath: path }) });
  return null;
}

const press = (init: KeyboardEventInit) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });

describe("标签快捷键", () => {
  it("Ctrl+Tab 只切当前组文件，组间快捷键保留各组活动文件", async () => {
    setSession({ tabs: [tab("a"), tab("b"), tab("c"), tab("d")], editorGroups: { ...emptyEditorGroups(), left: ["a", "b"], right: ["c", "d"], leftActive: "a", rightActive: "d", focused: "right" } });
    await act(async () => root.render(<KeysProbe tabs={getSession().tabs} activePath="d" reopenLast={async () => true} />));
    await press({ key: "Tab", ctrlKey: true }); expect(getSession().activePath).toBe("c"); expect(getSession().editorGroups?.right).toEqual(["c", "d"]);
    await press({ key: "ArrowLeft", ctrlKey: true, altKey: true }); expect(getSession().activePath).toBe("a");
    await press({ key: "Tab", ctrlKey: true }); expect(getSession().activePath).toBe("b"); expect(getSession().editorGroups?.left).toEqual(["a", "b"]);
    await press({ key: "ArrowRight", ctrlKey: true, altKey: true }); expect(getSession().activePath).toBe("c");
  });
  beforeEach(() => {
    const surface = document.createElement("div");
    surface.id = "wb-code-surface";
    document.body.appendChild(surface);
  });

  it("Ctrl+Tab 切到上一个用过的标签", async () => {
    setSession({ tabs: [tab("a"), tab("b")], activePath: "a" });
    await act(async () => root.render(<KeysProbe tabs={getSession().tabs} activePath="a" reopenLast={async () => true} />));
    await press({ key: "Tab", ctrlKey: true });
    expect(getSession().activePath).toBe("b");
  });

  it("重开最近关闭的标签：Eclipse 用 Ctrl+Alt+T，IDEA 用 Ctrl+Shift+T", async () => {
    const reopenLast = vi.fn(async () => true);
    await act(async () => root.render(<KeysProbe tabs={[]} activePath={null} reopenLast={reopenLast} />));
    // Eclipse 的 Ctrl+Shift+T 是「转到类型」，不能被恢复标签吃掉
    await press({ key: "t", ctrlKey: true, shiftKey: true });
    expect(reopenLast).not.toHaveBeenCalled();
    await press({ key: "t", ctrlKey: true, altKey: true });
    expect(reopenLast).toHaveBeenCalledTimes(1);

    localStorage.setItem("ncforge-keymap", "idea");
    await press({ key: "t", ctrlKey: true, shiftKey: true });
    expect(reopenLast).toHaveBeenCalledTimes(2);
  });

  it("文件页被工具页盖住时不抢 Ctrl+Tab", async () => {
    setSession({ tabs: [tab("a"), tab("b")], activePath: "a" });
    document.getElementById("wb-code-surface")!.hidden = true;
    await act(async () => root.render(<KeysProbe tabs={getSession().tabs} activePath="a" reopenLast={async () => true} />));
    await press({ key: "Tab", ctrlKey: true });
    expect(getSession().activePath).toBe("a");
  });

  it("模态框打开时不抢键", async () => {
    setSession({ tabs: [tab("a"), tab("b")], activePath: "a" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    await act(async () => root.render(<KeysProbe tabs={getSession().tabs} activePath="a" reopenLast={async () => true} />));
    await press({ key: "Tab", ctrlKey: true });
    expect(getSession().activePath).toBe("a");
  });
});
