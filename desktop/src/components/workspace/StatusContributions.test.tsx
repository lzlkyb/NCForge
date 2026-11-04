// @vitest-environment jsdom
/**
 * 状态栏的各页贡献。
 *
 * 盯三件事：编译 / 问题小签能一键回到对应面板；SVN 的数字只在该页订阅
 * （不能在启动时替用户跑 7.6 秒的扫描）；数据库页露出当前连接、事务与运行中查询。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ svnStatus: vi.fn(), svnInfo: vi.fn(), openLinkedDialog: vi.fn() }));
vi.mock("../../lib/svn", () => ({ svnStatus: mocks.svnStatus, svnInfo: mocks.svnInfo }));
vi.mock("../../lib/linkedDialog", () => ({ openLinkedDialog: mocks.openLinkedDialog }));

import { StatusContributions } from "./StatusContributions";
import { getSession, setSession } from "../../lib/workspaceSession";
import { setCodeDiags } from "../../lib/diagStore";
import {
  __resetDbForTest,
  activateTab,
  getDb,
  openSqlTab,
  patchTab,
  setConns,
  setTx,
  type SqlTab,
} from "../../lib/dbStore";
import type { DbConn } from "../../lib/dbApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** 显式收一个 Event 参数，才能直接当 EventListener 传进 addEventListener。 */
const makeNav = () => vi.fn((_: Event) => {});
let nav: ReturnType<typeof makeNav>;

beforeEach(() => {
  nav = makeNav();
  window.addEventListener("ncforge-navigate", nav);
  mocks.svnStatus.mockReset();
  mocks.svnInfo.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.removeEventListener("ncforge-navigate", nav);
  setCodeDiags([]);
  setSession({ compiling: false, compileResult: null, panelOpen: false, panelTab: "problems", root: null });
  __resetDbForTest();
});

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function render(activeTool: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <footer className="wb-status">
          <StatusContributions activeTool={activeTool} />
        </footer>
      </QueryClientProvider>,
    );
  });
  return host;
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("状态栏贡献", () => {
  it("编译中可点回编译输出，问题数可点回问题面板", async () => {
    act(() => setSession({ compiling: true }));
    const el = render("files");
    expect(el.textContent).toContain("编译中");

    await act(async () => button(el, "编译中")!.click());
    expect(getSession().panelOpen).toBe(true);
    expect(getSession().panelTab).toBe("build");
    expect((nav.mock.calls[0][0] as CustomEvent).detail).toBe("files");
    expect(nav.mock.calls[0][0].type).toBe("ncforge-navigate");

    act(() => setSession({ compiling: false }));
    act(() =>
      setCodeDiags([
        { path: "a.java", line: 1, column: 1, severity: "error", message: "找不到符号" },
        { path: "b.java", line: 2, column: 1, severity: "warning", message: "未使用的导入" },
      ]),
    );
    const chip = el.querySelector<HTMLButtonElement>('button[title="点击打开问题面板"]')!;
    expect(chip.textContent).toContain("1");
    await act(async () => chip.click());
    expect(getSession().panelTab).toBe("problems");
  });

  it("SVN 贡献只在版本控制页订阅，并显示改动数与版本号", async () => {
    mocks.svnStatus.mockResolvedValue({
      changes: { groups: [], shown: 3, total: 3, ignored: 2 },
      scanned: 120,
      generatedAtMs: Date.now(),
      hasConflict: false,
      reviewed: [],
    });
    mocks.svnInfo.mockResolvedValue({
      root: "C:/ws",
      url: "svn://example/project",
      revision: 4211,
      host: "example",
      user: "dev",
      hasPassword: true,
      credentialSource: "saved",
      bridgeAlive: true,
    });

    const el = render("files");
    expect(mocks.svnStatus).not.toHaveBeenCalled();

    act(() => root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <StatusContributions activeTool="svn" />
      </QueryClientProvider>,
    ));
    await flush();

    expect(mocks.svnStatus).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("改动 3");
    expect(el.textContent).toContain("忽略 2");
    expect(el.textContent).toContain("r4211");
  });

  it("代码页且选了工作区时露出「工程关联」入口，其余页不占状态栏", () => {
    const el = render("files");
    expect(button(el, "工程关联")).toBeUndefined();

    act(() => setSession({ root: "C:\\ws" }));
    const chip = button(el, "工程关联") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    act(() => chip.click());
    expect(mocks.openLinkedDialog).toHaveBeenCalledWith("chain");

    act(() => root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <StatusContributions activeTool="db" />
      </QueryClientProvider>,
    ));
    expect(button(el, "工程关联")).toBeUndefined();
  });

  it("数据库页露出当前连接、未提交事务与运行中的查询", () => {
    const conn: DbConn = {
      id: "c1",
      name: "测试库",
      env: "dev",
      source: "manual",
      url: "jdbc:oracle:thin:@127.0.0.1:1521/orcl",
      user: "u",
      propDs: null,
      autoCommit: false,
      note: "",
      hasPassword: false,
      engine: "java",
    };
    setConns([conn]);
    const tabId = openSqlTab("c1", "select 1 from dual");
    activateTab(tabId);
    setTx("c1", { autoCommit: false, statements: 2, rows: 3, since: Date.now() });

    const el = render("db");
    expect(el.textContent).toContain("数据库 · 测试库");
    expect(el.textContent).toContain("1 个会话待提交");

    act(() => patchTab<SqlTab>(tabId, { running: true }));
    expect(el.textContent).toContain("查询中");
  });

  it("汇总当前连接的主会话和独立槽，同槽去重并可定位单个标签", () => {
    const first = openSqlTab("c1");
    const sameSlot = openSqlTab("c1");
    const second = openSqlTab("c1");
    const other = openSqlTab("c2");
    const tx = { autoCommit: false, statements: 2, rows: 3, since: 1 };
    setTx("c1", tx);
    setTx("c2", tx);
    patchTab<SqlTab>(first, { slot: "1", tx });
    patchTab<SqlTab>(sameSlot, { slot: "1", tx });
    patchTab<SqlTab>(second, { slot: "2", tx: { ...tx, statements: 3 } });
    patchTab<SqlTab>(other, { slot: "3", tx });
    activateTab(first);
    const el = render("db");
    expect(el.textContent).toContain("3 个会话待提交");
    act(() => button(el, "会话待提交")!.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent).join(" ")).toContain("主会话");
    act(() => items.find((item) => item.textContent?.includes("独立会话 2"))!.click());
    expect(getDb().active).toBe(second);
    expect((nav.mock.calls[nav.mock.calls.length - 1][0] as CustomEvent).detail).toBe("db");
    // 定位不会顺带提交任何会话。
    expect(getDb().rt.c1.tx?.statements).toBe(2);
    expect(getDb().tabs.find((tab) => tab.id === second && tab.kind === "sql")).toMatchObject({ tx: { statements: 3 } });
  });
});
