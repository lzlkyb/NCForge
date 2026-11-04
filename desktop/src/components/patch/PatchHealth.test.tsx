// @vitest-environment jsdom
/**
 * 出包环境健康条：
 * - 只读缓存与模块级状态，不额外发请求（除用户点刷新 SVN）；
 * - 菜单中的四个 chip 各自说明状态（未编译 / 0 模块 / 扫描失败 / 未连库）；
 * - 点编译器 chip 要打开问题面板并跳到文件页。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompileResult } from "../../lib/compile";

const mocks = vi.hoisted(() => ({
  defaults: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../lib/patch", () => ({ patchDefaults: mocks.defaults }));
vi.mock("../../lib/svn", () => ({ svnStatus: mocks.status }));

import { PatchHealth } from "./PatchHealth";
import { __resetDbForTest } from "../../lib/dbStore";
import { setSession } from "../../lib/workspaceSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PatchHealth />
      </QueryClientProvider>,
    );
  });
  // 两个查询落地要跨几轮 microtask，单靠一轮 Promise.resolve 不够
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  return trigger!;
};

const chip = (text: string) =>
  [...document.querySelectorAll(".pk-health-chip")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

const compileResult = (patch: Partial<CompileResult>): CompileResult => ({
  ok: true,
  durationMs: 1200,
  sourceCount: 42,
  errorCount: 0,
  warningCount: 0,
  problems: [],
  jarCount: 3,
  rounds: 1,
  outDir: "C:/ws/out",
  diagnostics: [],
  ...patch,
});

beforeEach(() => {
  __resetDbForTest();
  setSession({ root: "C:/ws", compiling: false, compileResult: null });
  mocks.defaults.mockReset();
  mocks.status.mockReset();
  mocks.defaults.mockResolvedValue({
    workspaceRoot: "C:/ws",
    outDir: "C:/ws/out",
    outDirSource: "detect",
    outDirExists: true,
    outRoot: "C:/ws/out",
    outRootCandidates: ["C:/ws/out"],
    ncHome: "C:/nc",
    ncHomeModules: 7,
  });
  mocks.status.mockResolvedValue({
    changes: {
      groups: [
        {
          module: "ic",
          items: [
            {
              path: "C:/ws/ic/A.java",
              rel: "ic/A.java",
              module: "ic",
              letter: "M",
              status: "modified",
              revision: 1,
              isDir: false,
              ignored: false,
            },
            {
              path: "C:/ws/ic/out/A.class",
              rel: "ic/out/A.class",
              module: "ic",
              letter: "?",
              status: "unversioned",
              revision: 0,
              isDir: false,
              ignored: true,
            },
          ],
        },
      ],
      shown: 1,
      total: 1,
      ignored: 3,
    },
    scanned: 9000,
    generatedAtMs: Date.now(),
    hasConflict: false,
    reviewed: [],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  setSession({ root: undefined, compiling: false, compileResult: null });
});

describe("PatchHealth", () => {
  it("摘要保留真实异常，菜单可通过键盘选择并用 Esc 回到触发器", async () => {
    setSession({ compileResult: compileResult({ ok: false, errorCount: 2, warningCount: 1 }) });
    const trigger = await mount();
    expect(trigger.textContent).toContain("环境 · 1 项异常");
    expect(trigger.dataset.tone).toBe("bad");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const entries = document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
    expect(entries).toHaveLength(4);

    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(entries[0]);

    await act(async () => {
      entries[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("默认读数来自缓存：编译未跑、NC Home 正常、SVN 只算非产物改动、DB 未连接", async () => {
    await mount();

    expect(chip("编译器 · 未编译")?.dataset.tone).toBe("idle");
    expect(chip("NC Home · 7 模块")?.dataset.tone).toBe("ok");
    expect(chip("SVN · 1 改动")?.dataset.tone).toBe("ok");
    expect(chip("DB · 未连接")?.dataset.tone).toBe("warn");

    expect(mocks.defaults).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledTimes(1);
  });

  it("编译有错误时亮红，点一下打开问题面板并跳到文件页", async () => {
    setSession({ compileResult: compileResult({ ok: false, errorCount: 2, warningCount: 1 }) });
    await mount();

    const nav = vi.fn((_: Event) => {});
    window.addEventListener("ncforge-navigate", nav);
    try {
      const target = chip("编译器 · 2 错误");
      expect(target?.dataset.tone).toBe("bad");
      await act(async () => target!.click());
      expect(nav).toHaveBeenCalledTimes(1);
      expect((nav.mock.calls[0][0] as CustomEvent).detail).toBe("files");
      const s = (await import("../../lib/workspaceSession")).getSession();
      expect(s.panelOpen).toBe(true);
      expect(s.panelTab).toBe("problems");
    } finally {
      window.removeEventListener("ncforge-navigate", nav);
    }
  });

  it("NC Home 数不到模块时给黄色告警，而不是假装可用", async () => {
    mocks.defaults.mockResolvedValue({
      workspaceRoot: "C:/ws",
      outDir: "C:/ws/out",
      outDirSource: "detect",
      outDirExists: true,
      outRoot: "C:/ws/out",
      outRootCandidates: ["C:/ws/out"],
      ncHome: "C:/wrong",
      ncHomeModules: 0,
    });
    await mount();
    expect(chip("NC Home · 0 模块")?.dataset.tone).toBe("warn");
  });

  it("SVN 扫描失败时明说失败，点一下会重扫", async () => {
    mocks.status.mockRejectedValueOnce(new Error("svn: E155004 locked"));
    await mount();

    const failed = chip("SVN · 扫描失败");
    expect(failed?.dataset.tone).toBe("bad");

    await act(async () => failed!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });
});
