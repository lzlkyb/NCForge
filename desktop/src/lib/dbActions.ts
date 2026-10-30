import { toast } from "../components/ui/toast";
import { friendlyDbError } from "./db";
import { dbApi } from "./dbApi";
import { ask, confirmProdWrite, ensureConnected, guardTx, isLastTabOn } from "./dbConfirm";
import {
  appendOutput,
  closeTab,
  connOf,
  disconnect,
  execOne,
  explainInto,
  forgetColumns,
  getDb,
  loadConns,
  loadMeta,
  openSqlTab,
  openTableTab,
  patchTab,
  rtOf,
  setConns,
  sqlTabOf,
  tabOf,
  type ResultEntry,
  type SqlTab,
  type TableSub,
} from "./dbStore";
import { disposeSqlModel } from "./sqlModels";
import { isWrite, stmtKind } from "./sqlSplit";

/**
 * 数据库页的用户动作：把 store（状态）与 dbConfirm（要问一句的地方）串起来。
 * 组件只调这里，不自己拼流程——「关标签要先问事务」这类规则只写一遍。
 */

/** 新开控制台时默认用哪个连接：当前标签的 → 已连上的 → 第一个。 */
export function defaultConnId(): string | null {
  const db = getDb();
  const cur = tabOf(db.active)?.connId;
  if (cur && connOf(cur)) return cur;
  return db.conns.find((c) => rtOf(c.id).status === "connected")?.id ?? db.conns[0]?.id ?? null;
}

export async function newConsole(connId: string | null = defaultConnId(), sql = ""): Promise<string> {
  const id = openSqlTab(connId, sql);
  if (connId) void ensureConnected(connId);
  return id;
}

export async function openTable(connId: string, table: string, sub: TableSub = "data") {
  if (!(await ensureConnected(connId))) return;
  openTableTab(connId, table, sub);
}

/** 给 SQL 标签换连接。旧连接上如果只剩这个标签且有未提交事务，先问。 */
export async function switchConn(tabId: string, connId: string) {
  const tab = sqlTabOf(tabId);
  if (!tab || tab.connId === connId) return;
  if (isLastTabOn(tab.connId, tabId) && !(await guardTx(tab.connId, "切换连接"))) return;
  patchTab<SqlTab>(tabId, { connId });
  void ensureConnected(connId);
}

export async function requestCloseTab(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab) return;
  if (isLastTabOn(tab.connId, tabId) && !(await guardTx(tab.connId, "关闭标签"))) return;
  closeTab(tabId);
  if (tab.kind === "sql") disposeSqlModel(tabId);
}

export async function disconnectConn(connId: string) {
  if (!(await guardTx(connId, "断开连接"))) return;
  await disconnect(connId);
  forgetColumns(connId);
}

export async function deleteConn(connId: string) {
  const c = connOf(connId);
  if (!c) return;
  const ok = await ask("删除连接", `删除「${c.name}」？存在本机的口令一并删掉；用它的 SQL 标签会变成「未选连接」。`, "删除", true);
  if (!ok || !(await guardTx(connId, "删除连接"))) return;
  try {
    setConns(await dbApi.remove(connId));
    for (const t of getDb().tabs) {
      if (t.connId !== connId) continue;
      if (t.kind === "sql") patchTab<SqlTab>(t.id, { connId: null });
      else closeTab(t.id);
    }
  } catch (e) {
    toast(`删除失败：${friendlyDbError(e)}`, "error");
  }
}

/** 复制连接配置（口令不复制，第一次连时会问）。 */
export async function duplicateConn(connId: string) {
  const c = connOf(connId);
  if (!c) return;
  try {
    await dbApi.save({ ...c, id: null, name: `${c.name} 副本` });
    await loadConns();
  } catch (e) {
    toast(`复制失败：${friendlyDbError(e)}`, "error");
  }
}

export async function moveConn(fromId: string, toId: string) {
  const ids = getDb().conns.map((c) => c.id);
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  try {
    setConns(await dbApi.reorder(ids));
  } catch (e) {
    toast(`排序失败：${friendlyDbError(e)}`, "error");
  }
}

export async function refreshMeta(connId: string) {
  forgetColumns(connId);
  await loadMeta(connId);
}

/**
 * 按顺序执行一组语句；出错即停，返回出错语句的起始行（编辑器据此定位）。
 *
 * 结果标签只为「查询」与「出错」开；脚本里几百条 insert 的更新行数只进「输出」，
 * 不然结果栏会被几百个标签撑爆。单条写语句仍给一个结果页，用来提示提交。
 */
export async function runStatements(tabId: string, stmts: { text: string; startLine: number }[]): Promise<number | null> {
  const tab = sqlTabOf(tabId);
  if (!tab || tab.running || stmts.length === 0) return null;
  if (!tab.connId) {
    toast("先在工具条左边选一个连接", "warning");
    return null;
  }
  const connId = tab.connId;
  if (!(await ensureConnected(connId))) return null;
  patchTab<SqlTab>(tabId, { running: true, results: [], view: null });
  const kept: ResultEntry[] = [];
  let failLine: number | null = null;
  let ddl = false;
  try {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      if (isWrite(s.text) && !(await confirmProdWrite(tabId, connId, s.text))) {
        appendOutput(tabId, [{ at: Date.now(), text: `第 ${i + 1} 条未执行：已取消`, tone: "info" }]);
        break;
      }
      const r = await execOne(tabId, s.text, i + 1);
      if (r.kind !== "error" && stmtKind(s.text) === "ddl") ddl = true;
      if (r.kind !== "update" || stmts.length === 1) {
        kept.push(r);
        patchTab<SqlTab>(tabId, { results: [...kept], view: r.id });
      }
      if (r.kind === "error") {
        failLine = s.startLine;
        break;
      }
    }
  } finally {
    patchTab<SqlTab>(tabId, { running: false, ...(kept.length === 0 ? { view: "output" } : {}) });
  }
  // 建表 / 改表之后侧栏与补全要跟上
  if (ddl) void refreshMeta(connId);
  return failLine;
}

export async function explain(tabId: string, sql: string) {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId || !sql.trim()) return;
  if (!(await ensureConnected(tab.connId))) return;
  await explainInto(tabId, sql);
}
