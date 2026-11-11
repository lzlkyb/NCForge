// @vitest-environment jsdom
/**
 * 写回开始就该锁页面，不能等生产库确认框关掉。
 *
 * 确认框可能挂着几十秒。这期间若还能改格子，新改动不在这次 `changes` 快照里，
 * 写回成功后的 `load()` 会把它静默清掉——用户以为改上了，其实没了。
 * 用例守的是「`setSaving(true)` 早于确认结果」这个顺序。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  execBound: vi.fn(),
  begin: vi.fn(),
}));

vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../lib/db", () => ({
  friendlyDbError: (e: unknown) => String(e),
  parseDbError: (e: unknown) => ({ code: "other", message: String(e) }),
  qualifyTable: (schema: string, table: string) => `${schema}.${table}`,
}));
vi.mock("../lib/dbApi", () => ({ dbApi: { execBound: mocks.execBound } }));
vi.mock("../lib/dbConfirm", () => ({ confirmProdWrite: mocks.confirm }));
vi.mock("../lib/dbStore", () => ({
  claimCursor: vi.fn(),
  connOf: () => ({ name: "c1", autoCommit: false }),
  rtOf: () => ({ tx: undefined, info: { schema: "S" }, currentSchema: "S" }),
  setTx: vi.fn(),
  setTxNotice: vi.fn(),
}));
vi.mock("../lib/operations", () => ({
  beginOperation: mocks.begin,
  operationActive: () => false,
}));
vi.mock("../lib/dbOperations", () => ({
  dbTaskSpec: (...args: unknown[]) => ({ key: String(args[0]) }),
  dbTxKey: (connId: string | null, slot?: string | null) => `tx:${connId ?? ""}:${slot || "primary"}`,
}));
vi.mock("../lib/dbResultContext", () => ({ resultTargetIssue: () => undefined }));
vi.mock("../lib/dbOptimisticEdit", () => ({ lookupRow: vi.fn() }));
vi.mock("../lib/tableRows", () => ({ missingRequired: () => [] }));

import { useTableSave } from "./useTableSave";
import type { TableTab } from "../lib/dbStore";
import type { ColumnInfo, ColumnMeta } from "../lib/dbApi";
import type { ResultExecutionContext } from "../lib/dbResultContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
}

const tab = { kind: "table", id: "t1", connId: "c1", table: "T", schema: "S" } as unknown as TableTab;

function mountSave() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const setSaving = vi.fn();
  let save!: () => Promise<void>;
  function Probe() {
    save = useTableSave({
      tab,
      page: {
        columns: [{ name: "ID", type: "NUMBER" }] as ColumnMeta[],
        rows: [[1]],
        context: { connId: "c1", source: "表页", schema: "S" } as ResultExecutionContext,
        params: [],
      },
      pk: ["ID"],
      cols: [{ name: "ID", type: "NUMBER", nullable: false }] as ColumnInfo[],
      changes: [{ kind: "update", row: 0, cells: [{ column: 0, before: 1, after: 2 }], sql: "update S.T set ID=2", params: [2] }],
      sqls: ["update S.T set ID=2"],
      drafts: { drafts: [], deleted: [], pending: 0, restoreRow: vi.fn() },
      readonly: false,
      txLost: false,
      onCommitted: vi.fn(),
      setSaving,
      setPreview: vi.fn(),
      setConflict: vi.fn(),
      setConflictValues: vi.fn(),
      setConnectionError: vi.fn(),
      load: vi.fn(async () => {}),
    });
    return null;
  }
  act(() => root.render(<Probe />));
  return { root, host, setSaving, run: () => save() };
}

let mounted: ReturnType<typeof mountSave> | null = null;
afterEach(() => {
  act(() => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = null;
  vi.clearAllMocks();
});

describe("表页写回：确认期间必须已锁页面", () => {
  it("生产库确认还没回答时，saving 已经是 true", async () => {
    const gate = deferred<boolean>();
    mocks.confirm.mockReturnValue(gate.p);
    mocks.begin.mockReturnValue({ id: 1, update: vi.fn(), finish: vi.fn() });
    mounted = mountSave();
    let running!: Promise<void>;
    act(() => { running = mounted!.run(); });
    await act(async () => { await Promise.resolve(); });

    // 确认框还挂着（gate 未 resolve），页面就必须已经锁住。
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mounted.setSaving).toHaveBeenCalledWith(true);
    expect(mocks.execBound).not.toHaveBeenCalled();

    gate.resolve(false);
    await act(async () => { await running; });
    // 取消确认要复位，否则页面永远停在只读。
    expect(mounted.setSaving).toHaveBeenLastCalledWith(false);
    expect(mocks.execBound).not.toHaveBeenCalled();
  });
});
