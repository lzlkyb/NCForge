// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "./HistoryPanel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

const PATH = "C:\\w\\newar\\modules\\ic\\A.java";
const V1 = { id: "v1", ts: Date.now() - 60_000, size: 8, sha: "aaa" };
const V2 = { id: "v2", ts: Date.now() - 3_600_000, size: 20, sha: "bbb" };
const DISK = {
  text: "a\nCHANGED\n",
  encoding: "UTF-8" as const,
  hasBom: false,
  eol: "LF" as const,
  lossless: true,
  size: 9,
  mtimeMs: 123,
};

let root: Root;
let container: HTMLDivElement;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 与 FilesTab 同构：props 随 state 变，避免静态快照导致组件永远拿旧值 */
function Harness({
  dirty = false,
  onClose = () => {},
  onRestored = () => {},
}: {
  dirty?: boolean;
  onClose?: () => void;
  onRestored?: (p: string) => void;
}) {
  return (
    <>
      {/* 触发按钮在面板外面（真实结构里在 EditorNavRow 行内），验证排除逻辑 */}
      <button type="button" data-popover="history">
        历史
      </button>
      <HistoryPanel
        open={true}
        onClose={onClose}
        path={PATH}
        dirty={dirty}
        onRestored={onRestored}
      />
    </>
  );
}

const btn = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

/** 原生派发：外点监听挂在 document 上，不走 React 合成事件 */
const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) => {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  });
};

const render = async (ui: React.ReactElement) => {
  await act(async () => root.render(ui));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "local_history_list") return [V1, V2];
    if (cmd === "fs_read_file") return DISK;
    if (cmd === "local_history_read") return { size: 8, text: "a\nb\n", truncated: false, ts: V1.ts };
    if (cmd === "local_history_restore") return undefined;
    throw new Error(`unexpected command: ${cmd}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("HistoryPanel", () => {
  it("打开时拉版本列表 + 读磁盘现状", async () => {
    await render(<Harness />);
    expect(mocks.invoke).toHaveBeenCalledWith("local_history_list", { path: PATH });
    expect(mocks.invoke).toHaveBeenCalledWith("fs_read_file", { path: PATH });
    // 两版都列出来
    expect(container.querySelectorAll(".wb-hist-row").length).toBe(2);
  });

  it("没有历史版本时给引导文案", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_history_list") return [];
      if (cmd === "fs_read_file") return DISK;
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render(<Harness />);
    expect(container.textContent).toContain("还没有历史版本");
  });

  it("点某版本读预览，并给出与磁盘的差异统计", async () => {
    await render(<Harness />);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("local_history_read", { path: PATH, id: "v1" });
    // 旧版 "a\nb\n" vs 磁盘 "a\nCHANGED\n" → +1 −1
    expect(container.querySelector(".wb-hist-changes")?.textContent).toContain("+1");
    expect(container.querySelector(".wb-hist-changes")?.textContent).toContain("−1");
    // 差异行里能看到被删的 b 和新增的 CHANGED
    const lines = [...container.querySelectorAll(".wb-hist-line")].map((n) => n.textContent);
    expect(lines.some((t) => t?.includes("CHANGED"))).toBe(true);
    expect(lines.some((t) => t?.includes("b"))).toBe(true);
  });

  it("文件有未保存修改时禁用恢复并说明原因", async () => {
    await render(<Harness dirty={true} />);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    expect(container.textContent).toContain("先保存或还原后再恢复历史版本");
    expect(btn("恢复此版本")).toBeUndefined();
  });

  it("恢复分两步确认，带上磁盘 mtime 做冲突校验", async () => {
    const onRestored = vi.fn();
    await render(<Harness onRestored={onRestored} />);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    await act(async () => {
      btn("恢复此版本")!.click();
    });
    // 第一步只进入确认态，不动磁盘
    expect(mocks.invoke).not.toHaveBeenCalledWith("local_history_restore", expect.anything());
    expect(container.textContent).toContain("确认恢复");
    await act(async () => {
      btn("确认恢复")!.click();
    });
    // expectedMtimeMs 来自打开时读到的磁盘快照（后端靠它防「磁盘被改过还覆盖」）
    expect(mocks.invoke).toHaveBeenCalledWith("local_history_restore", {
      path: PATH,
      id: "v1",
      expectedMtimeMs: 123,
    });
    expect(onRestored).toHaveBeenCalledWith(PATH);
    expect(mocks.toast).toHaveBeenCalledWith("已恢复历史版本", "success");
    // 恢复后重新拉列表（恢复前的内容也被归档了一版），选中态清空
    await act(async () => {});
    expect(container.querySelectorAll(".wb-hist-row").length).toBe(2);
    expect(container.querySelector(".wb-hist-detail")).toBeNull();
  });

  it("恢复失败时原因留在框内，不弹错误 toast", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_history_list") return [V1];
      if (cmd === "fs_read_file") return DISK;
      if (cmd === "local_history_read") return { size: 8, text: "a\nb\n", truncated: false, ts: V1.ts };
      if (cmd === "local_history_restore") throw new Error("CONFLICT: 磁盘已被其他程序修改");
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render(<Harness />);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    await act(async () => {
      btn("恢复此版本")!.click();
    });
    await act(async () => {
      btn("确认恢复")!.click();
    });
    expect(container.querySelector(".wb-hist-error")?.textContent).toContain("CONFLICT");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("超大版本只给大小，仍允许恢复", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_history_list") return [V1];
      if (cmd === "fs_read_file") return DISK;
      if (cmd === "local_history_read")
        return { size: 9_000_000, text: null, truncated: true, ts: V1.ts };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render(<Harness />);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    expect(container.textContent).toContain("太大不做对比");
    expect(btn("恢复此版本")).toBeTruthy();
  });
});

describe("HistoryPanel 关闭行为（无遮罩，外点 + Esc 挂 document）", () => {
  it("点面板外面关闭", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fire(document.body, "pointerdown");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点面板内部不关", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fire(container.querySelector(".wb-hist-head")!, "pointerdown");
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    fire(container.querySelector(".wb-hist-detail")!, "pointerdown");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点触发按钮不关：那是开关，交给外层 toggle", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fire(container.querySelector('[data-popover="history"]')!, "pointerdown");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc 关闭", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("恢复进行中点外面、按 Esc 都不关：关了用户就不知道恢复结果了", async () => {
    // restore 永不 resolve：把 phase 钉在 restoring
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_history_list") return [V1];
      if (cmd === "fs_read_file") return DISK;
      if (cmd === "local_history_read")
        return { size: 8, text: "a\nb\n", truncated: false, ts: V1.ts };
      if (cmd === "local_history_restore") return new Promise(() => {});
      throw new Error(`unexpected command: ${cmd}`);
    });
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-hist-row")[0].click();
    });
    await act(async () => {
      btn("恢复此版本")!.click();
    });
    await act(async () => {
      btn("确认恢复")!.click();
    });
    expect(container.textContent).toContain("恢复中");

    fire(document.body, "pointerdown");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
