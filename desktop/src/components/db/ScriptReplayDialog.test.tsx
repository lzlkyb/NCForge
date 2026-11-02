// @vitest-environment jsdom
/**
 * 回放 `.sql` 的接线：读文件 → 切语句 → 交给 runStatements（按顺序、带忽略错误开关）→
 * 失败清单可见且能导出成可再执行的脚本。
 *
 * 盯的是一眼看不出的接错：语句顺序被打乱、`ignoreErrors` 没传下去（用户勾了却出错即停）、
 * 失败只显示条数不显示哪条（导出的脚本跟界面对不上）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runStatements: vi.fn(),
  downloadText: vi.fn(),
  toast: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("../../lib/dbActions", () => ({ runStatements: mocks.runStatements }));
vi.mock("../../lib/resultExport", () => ({ downloadText: mocks.downloadText }));
vi.mock("../../lib/dbStore", () => ({
  connOf: () => ({ id: "c1", name: "测试库", user: "NC65", env: "test" }),
}));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

import { ScriptReplayDialog } from "./ScriptReplayDialog";
import type { SqlTab } from "../../lib/dbStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = { kind: "sql", id: "t1", title: "SQL", connId: "c1", slot: null } as unknown as SqlTab;

const SCRIPT = "select 1 from dual;\ninsert into a values (1);\nupdate b set x = 1 where id = 2;\n";

const OUTCOME = {
  failLine: 2,
  failures: [{ index: 2, line: 2, text: "insert into a values (1)", error: "ORA-00942: table or view does not exist" }],
  done: 3,
  stoppedByUser: false,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.runStatements.mockResolvedValue(OUTCOME);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => {});

const byText = (sel: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));

async function mount() {
  await act(async () => {
    root.render(<ScriptReplayDialog tab={TAB} onClose={mocks.onClose} />);
  });
  await flush();
}

/** 给隐藏的 file input 塞一个文件并触发 change（React 靠冒泡的 change 事件接住）。 */
async function pick(text: string, name = "mig.sql") {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeTruthy();
  const file = new File([text], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

describe("ScriptReplayDialog", () => {
  it("读文件后切出语句并预览，执行时按原文顺序交给 runStatements", async () => {
    await mount();
    await pick(SCRIPT);

    expect(document.body.textContent).toContain("3 条语句");
    expect(document.body.textContent).toContain("UTF-8");
    expect(document.body.textContent).toContain("第 1 行");

    await act(async () => byText("button", "开始回放")?.click());
    await flush();

    expect(mocks.runStatements).toHaveBeenCalledTimes(1);
    const [tabId, stmts, opts] = mocks.runStatements.mock.calls[0];
    expect(tabId).toBe("t1");
    expect(stmts.map((s: { text: string }) => s.text)).toEqual([
      "select 1 from dual",
      "insert into a values (1)",
      "update b set x = 1 where id = 2",
    ]);
    expect(opts.ignoreErrors).toBe(false);
    expect(typeof opts.onProgress).toBe("function");
  });

  it("勾了「出错后继续」就把 ignoreErrors 传下去", async () => {
    await mount();
    await pick(SCRIPT);

    const box = document.querySelector<HTMLInputElement>(".dbx-sr-opt input");
    expect(box?.checked).toBe(false);
    await act(async () => box?.click());
    await act(async () => byText("button", "开始回放")?.click());
    await flush();

    expect(mocks.runStatements.mock.calls[0][2].ignoreErrors).toBe(true);
  });

  it("失败逐条列出来，导出的脚本带着条号与行号", async () => {
    await mount();
    await pick(SCRIPT);

    await act(async () => byText("button", "开始回放")?.click());
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("执行了 3/3 条");
    expect(text).toContain("失败 1 条");
    expect(text).toContain("ORA-00942: table or view does not exist");

    await act(async () => byText("button", "导出失败语句")?.click());
    expect(mocks.downloadText).toHaveBeenCalledTimes(1);
    const [name, content, mime, bom] = mocks.downloadText.mock.calls[0];
    expect(name).toBe("mig.failed.sql");
    expect(content).toContain("-- 第 2 条（第 2 行）：ORA-00942");
    expect(content).toContain("insert into a values (1);");
    expect(mime).toBe("text/plain");
    expect(bom).toBe(false);
  });

  it("超过 10MB 在入口就拒掉，不读进内存也不切分", async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([SCRIPT], "big.sql", { type: "text/plain" });
    Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(document.body.textContent).toContain("超过 10MB 上限");
    expect((byText("button", "开始回放") as HTMLButtonElement).disabled).toBe(true);
  });
});
