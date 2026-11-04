// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFilesSaved, prepareRestart } from "./terminatePreflight";

const h = vi.hoisted(() => ({
  db: { loaded: true, loadError: null as string | null, conns: [{ id: "dev", name: "开发库" }], rt: {} as Record<string, unknown>, tabs: [] as Array<Record<string, unknown>>, active: null },
  session: { compiling: false, tabs: [] as Array<Record<string, unknown>> },
  running: false,
  pendingTx: vi.fn(async () => [] as Array<Record<string, unknown>>),
  ask: vi.fn(async (_title: string, _message: string, _ok: string) => false),
  askUnsaved: vi.fn(async (_files: unknown, _save: unknown, _action: string, _allowDiscard: boolean) => "save" as "save" | "discard" | "cancel"),
  collect: vi.fn(() => [{ path: "/invoice.java", name: "invoice.java" }]),
  save: vi.fn(async () => ({ failed: [] as Array<{ path: string; name: string; reason: string }> })),
  open: vi.fn(), toast: vi.fn(), loadConns: vi.fn(),
}));
vi.mock("./dbConfirm", () => ({ ask: h.ask, askUnsavedFiles: h.askUnsaved }));
vi.mock("./dbApi", () => ({ dbApi: { pendingTx: h.pendingTx } }));
vi.mock("./dbStore", () => ({ getDb: () => h.db, loadConns: h.loadConns }));
vi.mock("./workspaceSession", () => ({ getSession: () => h.session }));
vi.mock("./ncTasks", () => ({ isNcTaskRunning: () => h.running }));
vi.mock("./quitGuard", () => ({ mergePending: (rows: Array<{ state: string }>) => rows.filter(row => row.state !== "clean") }));
vi.mock("./tabDirty", () => ({ isUnsaved: (tab: { dirty: boolean }) => tab.dirty }));
vi.mock("./saveAllDirty", () => ({ collectUnsaved: h.collect, saveAllDirty: h.save }));
vi.mock("./openFileRequest", () => ({ requestOpenFile: h.open }));
vi.mock("./db", () => ({ friendlyDbError: (error: unknown) => String(error) }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));

beforeEach(() => {
  h.session.compiling = false; h.session.tabs = []; h.running = false;
  h.db.loaded = true; h.db.loadError = null; h.db.rt = {}; h.db.tabs = [];
  h.pendingTx.mockReset(); h.pendingTx.mockResolvedValue([]);
  h.ask.mockReset(); h.ask.mockResolvedValue(false);
  h.askUnsaved.mockReset(); h.askUnsaved.mockResolvedValue("save");
  h.collect.mockReset(); h.collect.mockReturnValue([{ path: "/invoice.java", name: "invoice.java" }]);
  h.save.mockReset(); h.save.mockResolvedValue({ failed: [] });
  h.toast.mockClear(); h.open.mockClear();
});

describe("更新安装前的工作保护", () => {
  it("空闲且无修改时放行，无须加载保存模块", async () => {
    expect(await prepareRestart()).toBe(true);
    expect(h.collect).not.toHaveBeenCalled(); expect(h.ask).not.toHaveBeenCalled();
  });
  it.each(["compile", "task", "sql", "dict"])("运行中的 %s 阻止安装", async kind => {
    if (kind === "compile") h.session.compiling = true;
    if (kind === "task") h.running = true;
    if (kind === "sql") h.db.tabs = [{ kind: "sql", running: true }];
    if (kind === "dict") h.db.tabs = [{ kind: "dict", state: { running: true } }];
    expect(await prepareRestart()).toBe(false); expect(h.pendingTx).not.toHaveBeenCalled();
  });
  it("更新的保存确认不提供丢弃修改入口", async () => {
    h.session.tabs = [{ dirty: true }]; h.askUnsaved.mockResolvedValue("cancel");
    expect(await prepareRestart()).toBe(false);
    expect(h.askUnsaved.mock.calls[0].slice(2)).toEqual(["安装更新", false]);
    expect(h.pendingTx).not.toHaveBeenCalled();
  });
  it("保存未完成时不能按旧快照安装", async () => {
    h.session.tabs = [{ dirty: true }];
    expect(await prepareRestart()).toBe(false);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("状态已变化"), "warning");
  });
  it("严格保存检查加载失败时停止，普通退出沿用既有行为", async () => {
    h.session.tabs = [{ dirty: true }]; h.collect.mockImplementation(() => { throw new Error("save unavailable"); });
    expect(await ensureFilesSaved("安装更新", true)).toBe(false);
    expect(await ensureFilesSaved("退出")).toBe(true);
  });
  it("事务探测失败或状态未知均不能安装", async () => {
    h.pendingTx.mockRejectedValueOnce(new Error("timeout"));
    expect(await prepareRestart()).toBe(false);
    h.pendingTx.mockResolvedValue([{ state: "unknown", name: "开发库" }]);
    expect(await prepareRestart()).toBe(false); expect(h.ask).toHaveBeenCalled();
  });
  it("独立会话未提交时即使后端快照为空也停止", async () => {
    h.db.tabs = [{ kind: "sql", id: "s1", connId: "dev", title: "查询 1", slot: "2", tx: { autoCommit: false, statements: 1 } }];
    expect(await prepareRestart()).toBe(false);
    expect(h.ask.mock.calls[0][1]).toContain("独立会话 2");
  });
  it("处理事务会返回数据库，不在更新中批量提交", async () => {
    h.pendingTx.mockResolvedValue([{ state: "pending", name: "开发库" }]); h.ask.mockResolvedValue(true);
    const navigate = vi.fn(); window.addEventListener("ncforge-navigate", navigate);
    try {
      expect(await prepareRestart()).toBe(false); expect(navigate).toHaveBeenCalled();
      expect((navigate.mock.calls[0][0] as CustomEvent).detail).toBe("db");
    } finally { window.removeEventListener("ncforge-navigate", navigate); }
  });
  it("事务检查期间新增修改或任务时再次拦下", async () => {
    h.pendingTx.mockImplementationOnce(async () => { h.session.tabs = [{ dirty: true }]; return []; });
    expect(await prepareRestart()).toBe(false);
    h.session.tabs = []; h.pendingTx.mockImplementationOnce(async () => { h.running = true; return []; });
    expect(await prepareRestart()).toBe(false);
  });
});
