import { toast } from "../components/ui/toast";
import { friendlyDbError } from "./db";
import { dbApi } from "./dbApi";
import { ask, confirmProdWrite, ensureConnected, guardSlotTx, guardTx, isLastTabOn } from "./dbConfirm";
import {
  appendOutput,
  clearSlots,
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
  releaseSlot,
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

/**
 * 正在执行时离开这个标签：先问，再尽量把它停下来。
 *
 * 为什么必须拦：执行中的语句不会因为标签消失而停下——后端照样跑完、写语句照样提交，
 * 而 `patchTab` / `appendOutput` 落在已删除的标签上会被静默丢弃（`dbStore` 的 `map`）。
 * 用户既看不到结果，也不知道库到底改没改。取消是尽力而为（计算类语句立刻生效，
 * 卡在服务端等待的语句受块边界支配），所以文案不能承诺「一定没执行」。
 */
async function guardRunning(tab: SqlTab | null | undefined, reason: string): Promise<boolean> {
  if (!tab?.running) return true;
  const ok = await ask(
    `${reason}正在执行的语句？`,
    "这个标签里还有语句在执行。取消是尽力而为：计算类语句立刻停下，正卡在库里的写语句可能已经跑完并提交，而结果不会再显示给你。",
    `${reason}并取消执行`,
    true,
  );
  if (!ok) return false;
  if (tab.connId) {
    try {
      await dbApi.cancel(tab.connId, tab.slot);
    } catch {
      // 取消失败不该挡住关闭：语句本来就可能已经结束
    }
  }
  return true;
}

/** 给 SQL 标签换连接。旧连接上如果只剩这个标签且有未提交事务，先问。 */
export async function switchConn(tabId: string, connId: string) {
  const tab = sqlTabOf(tabId);
  if (!tab || tab.connId === connId) return;
  if (!(await guardRunning(tab, "切换连接"))) return;
  if (isLastTabOn(tab.connId, tabId) && !(await guardTx(tab.connId, "切换连接"))) return;
  // 槽属于旧连接：换连接前先把它的未提交写入问清楚，再放掉
  if (!(await guardSlotTx(tab.connId, tab.slot, "切换连接"))) return;
  await releaseSlot(tab.connId, tab.slot);
  // 结果必须一起清掉：留着上一个库的行，而「导出 / 复制为 insert」用的是**新**连接，
  // 两库同名表时导出的就是错数据，全程没有任何提示。计划同理（属于旧连接的执行计划）。
  patchTab<SqlTab>(tabId, { connId, slot: null, tx: undefined, results: [], view: null, plan: null });
  void ensureConnected(connId);
}

export async function requestCloseTab(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab) return;
  if (!(await guardRunning(sqlTabOf(tabId), "关闭标签"))) return;
  if (isLastTabOn(tab.connId, tabId) && !(await guardTx(tab.connId, "关闭标签"))) return;
  if (tab.kind === "sql") {
    // 槽各自独立事务：primary 干净不代表这个标签里没有没提交的 update
    if (!(await guardSlotTx(tab.connId, tab.slot, "关闭标签"))) return;
    await releaseSlot(tab.connId, tab.slot);
  }
  closeTab(tabId);
  if (tab.kind === "sql") disposeSqlModel(tabId);
}

/** 断开/删除连接前：primary 与这条连接上所有 SQL 标签的槽都要问一遍。 */
async function guardAllSessions(connId: string, reason: string): Promise<boolean> {
  if (!(await guardTx(connId, reason))) return false;
  for (const t of getDb().tabs) {
    if (t.connId !== connId || t.kind !== "sql") continue;
    if (!(await guardSlotTx(connId, t.slot, reason))) return false;
  }
  return true;
}

export async function disconnectConn(connId: string) {
  // 只问 primary 会漏掉槽里的未提交写入——后端断开时会把槽一起收掉。
  if (!(await guardAllSessions(connId, "断开连接"))) return;
  await disconnect(connId);
  // 后端已经把槽一并收掉；前端要把标签上的槽名清掉，否则下次执行会打到不存在的会话
  clearSlots(connId);
  forgetColumns(connId);
}

export async function deleteConn(connId: string) {
  const c = connOf(connId);
  if (!c) return;
  const ok = await ask("删除连接", `删除「${c.name}」？存在本机的口令一并删掉；用它的 SQL 标签会变成「未选连接」。`, "删除", true);
  if (!ok || !(await guardAllSessions(connId, "删除连接"))) return;
  try {
    setConns(await dbApi.remove(connId));
    clearSlots(connId);
    for (const t of getDb().tabs) {
      if (t.connId !== connId) continue;
      if (t.kind === "sql") patchTab<SqlTab>(t.id, { connId: null, slot: null, tx: undefined });
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
