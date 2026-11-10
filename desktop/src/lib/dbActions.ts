import { toast } from "../components/ui/toast";
import { friendlyDbError, plsqlErrorLine } from "./db";
import { dbApi } from "./dbApi";
import { beginOperation, operationActive } from "./operations";
import { dbTaskSpec, dbTxKey } from "./dbOperations";
import { forgetColumnZh } from "./dbColumnZh";
import { ask, confirmProdWrite, ensureConnected, guardSlotTx, guardTx, isLastTabOn } from "./dbConfirm";
import { clearFavorites } from "./dbFavorites";
import {
  activateTab,
  appendOutput,
  clearSlots,
  closeTab,
  connOf,
  defaultConnId,
  disconnect,
  execOne,
  explainInto,
  forgetColumns,
  getDb,
  loadConns,
  loadMeta,
  restoreClosedTab,
  openDictTab,
  openSqlTab,
  openTableTab,
  patchTab,
  releaseSlot,
  rtOf,
  setConns,
  setTxNotice,
  sqlTabOf,
  tabOf,
  type ResultEntry,
  type SqlTab,
  type TableSub,
} from "./dbStore";
import { disposeSqlModel } from "./sqlModels";
import { isWrite, stmtKind } from "./sqlSplit";
import { captureResultContext, type SqlRunTarget } from "./dbResultContext";
import { dbTabLabel } from "./dbPendingSessions";
import { clearEditsForTab, pendingForTab } from "./dbDirtyEdits";

/**
 * 数据库页的用户动作：把 store（状态）与 dbConfirm（要问一句的地方）串起来。
 * 组件只调这里，不自己拼流程——「关标签要先问事务」这类规则只写一遍。
 */

/**
 * 离开当前文档前问一句：表页 / 结果网格的改动都在组件本地 state 里，
 * 切文档、切子页、切结果标签或关闭会直接卸载组件，改动就静默没了。
 */
async function confirmDiscardEdits(tabId: string | null | undefined, action: string): Promise<boolean> {
  if (!tabId) return true;
  const count = pendingForTab(tabId);
  if (count <= 0) return true;
  const tab = tabOf(tabId);
  return ask(
    "有未写回的改动",
    `「${tab ? dbTabLabel(tab) : "当前标签"}」里还有 ${count} 处改动没有写回数据库。${action}后这些改动会丢失；需要保留请先点「写回」。`,
    `丢弃并${action}`,
    true,
  );
}

/**
 * 切换文档标签：先确认不会丢改动。
 *
 * 干净的标签必须**同步**切走（键盘方向键、点击都要即时响应），只有确实有未写回
 * 改动时才等确认框。
 */
export function requestActivateTab(tabId: string): void | Promise<void> {
  const active = getDb().active;
  if (active === tabId) return;
  if (!active || pendingForTab(active) <= 0) { activateTab(tabId); return; }
  return (async () => {
    if (!(await confirmDiscardEdits(active, "切换标签"))) return;
    activateTab(tabId);
  })();
}

/** 恢复最近关闭的标签会切走当前文档，同样先确认；当前标签干净时同步恢复。 */
export function requestRestoreClosedTab(entryId?: string): string | null | Promise<string | null> {
  const active = getDb().active;
  if (!active || pendingForTab(active) <= 0) return restoreClosedTab(entryId);
  return (async () => ((await confirmDiscardEdits(active, "恢复标签")) ? restoreClosedTab(entryId) : null))();
}

export async function newConsole(connId: string | null = defaultConnId(), sql = ""): Promise<string | null> {
  // 新控制台会切换到新标签，当前标签若是脏的必须先问
  if (!(await confirmDiscardEdits(getDb().active, "新建控制台"))) return null;
  const id = openSqlTab(connId, sql);
  if (connId) void ensureConnected(connId);
  return id;
}

export async function openTable(connId: string, table: string, sub: TableSub = "data") {
  if (!(await confirmDiscardEdits(getDb().active, "打开表页"))) return;
  if (!(await ensureConnected(connId))) return;
  openTableTab(connId, table, sub);
}

/** 打开数据字典（会切走当前文档）。 */
export async function openDict(connId: string | null) {
  if (!(await confirmDiscardEdits(getDb().active, "打开数据字典"))) return;
  openDictTab(connId);
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
  if (tab && operationActive("db." + dbTxKey(tab.connId, tab.slot))) {
    toast("等待当前事务操作结束后再" + reason, "info");
    return false;
  }
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
  // 换连接要清掉结果集，结果网格里的未写回改动会跟着一起消失
  if (!(await confirmDiscardEdits(tabId, "切换连接"))) return;
  if (!(await guardRunning(tab, "切换连接"))) return;
  if (isLastTabOn(tab.connId, tabId) && !(await guardTx(tab.connId, "切换连接"))) return;
  // 槽属于旧连接：换连接前先把它的未提交写入问清楚，再放掉
  if (!(await guardSlotTx(tab.connId, tab.slot, "切换连接"))) return;
  await releaseSlot(tab.connId, tab.slot);
  // 结果必须一起清掉：留着上一个库的行，而「导出 / 复制为 insert」用的是**新**连接，
  // 两库同名表时导出的就是错数据，全程没有任何提示。计划同理（属于旧连接的执行计划）。
  patchTab<SqlTab>(tabId, { connId, slot: null, tx: undefined, txNotice: undefined, results: [], view: null, plan: null, running: false, executionId: undefined });
  void ensureConnected(connId);
}

export async function requestCloseTab(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab) return;
  // 字典标签不占会话、没有可丢的事务，关它不该顺带问连接上别的事务
  if (tab.kind === "dict" || tab.kind === "compare") {
    closeTab(tabId);
    return;
  }
  if (!(await confirmDiscardEdits(tabId, "关闭标签"))) return;
  if (!(await guardRunning(sqlTabOf(tabId), "关闭标签"))) return;
  if (isLastTabOn(tab.connId, tabId) && !(await guardTx(tab.connId, "关闭标签"))) return;
  if (tab.kind === "sql") {
    // 槽各自独立事务：primary 干净不代表这个标签里没有没提交的 update
    if (!(await guardSlotTx(tab.connId, tab.slot, "关闭标签"))) return;
    await releaseSlot(tab.connId, tab.slot);
  }
  const closedId = closeTab(tabId);
  // 标签没了，登记表里的计数也要立刻清掉，否则圆点会挂在一个不存在的标签上
  clearEditsForTab(tabId);
  if (tab.kind === "sql") disposeSqlModel(tabId);
  // 关掉之后给一次「撤销」：草稿本来就没了入口，前置确认弹窗只会让每次关闭都变烦。
  if (closedId) {
    toast(`已关闭「${dbTabLabel(tab)}」`, "info", {
      action: { label: "撤销", onClick: () => { restoreClosedTab(closedId); } },
    });
  }
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

/**
 * 断开连接：先问 primary + 每个槽有没有未提交写入。
 *
 * 返回 `false` = 用户在「提交 / 回滚 / 取消」里点了取消，会话仍然活着。
 * 调用方（如编辑连接后保存）必须据此中止后续动作。
 */
export async function disconnectConn(connId: string): Promise<boolean> {
  // 只问 primary 会漏掉槽里的未提交写入——后端断开时会把槽一起收掉。
  if (!(await guardAllSessions(connId, "断开连接"))) return false;
  await disconnect(connId);
  // 后端已经把槽一并收掉；前端要把标签上的槽名清掉，否则下次执行会打到不存在的会话
  clearSlots(connId);
  forgetColumns(connId);
  forgetColumnZh(connId);
  return true;
}

export async function deleteConn(connId: string) {
  const c = connOf(connId);
  if (!c) return;
  const ok = await ask("删除连接", `删除「${c.name}」？存在本机的口令一并删掉；用它的 SQL 标签会变成「未选连接」。`, "删除", true);
  if (!ok || !(await guardAllSessions(connId, "删除连接"))) return;
  try {
    const task=beginOperation(dbTaskSpec(`connection.delete:${connId}`,"删除数据库连接配置",connId,"连接配置",c.name));
    if(!task) return;
    try {setConns(await dbApi.remove(connId));task.finish("success","连接配置已删除");}
    catch(e) {task.finish("failed","删除失败，返回数据库页查看原因");throw e;}
    clearFavorites(connId);
    clearSlots(connId);
    for (const t of getDb().tabs) {
      if (t.connId !== connId) continue;
      if (t.kind === "sql") patchTab<SqlTab>(t.id, { connId: null, slot: null, tx: undefined, executionId: undefined, results: [], plan: null, view: null });
      else closeTab(t.id, false); // 连接已删，这份表页恢复不出来，别塞进找回栈
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
    const task=beginOperation(dbTaskSpec(`connection.copy:${connId}`,"复制数据库连接配置",connId,"连接配置",c.name));
    if(!task) return;
    try {await dbApi.save({ ...c, id: null, name: `${c.name} 副本` });task.finish("success","连接配置已复制（未复制口令）");}
    catch(e) {task.finish("failed","复制失败，返回数据库页查看原因");throw e;}
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
  forgetColumnZh(connId);
  await loadMeta(connId,true);
}

/** 一条执行失败的语句（回放脚本时逐条记下来，供导出 / 重跑）。 */
export interface ScriptFailure {
  /** 第几条（从 1 开始）。 */
  index: number;
  /** 在脚本里的起始行。 */
  line: number;
  text: string;
  error: string;
}

export interface RunOutcome {
  /** 第一条出错语句的起始行（编辑器据此定位）；null = 没出错 / 没跑。 */
  failLine: number | null;
  failures: ScriptFailure[];
  /** 实际执行的条数（含失败的）。 */
  done: number;
  /** 生产库确认被拒：后面的语句没跑。 */
  stoppedByUser: boolean;
}

export interface RunOptions {
  /** 诊断操作才采集会话统计；普通查询不增加两次统计往返。 */
  collectStats?: boolean;
  /** 出错后继续执行剩余语句（回放迁移脚本用）；默认出错即停。 */
  ignoreErrors?: boolean;
  /** 每条开始前回调（回放进度用）。 */
  onProgress?: (p: { done: number; total: number; line: number; text: string }) => void;
}

/**
 * 按顺序执行一组语句；默认出错即停，并返回出错语句的起始行（编辑器据此定位）。
 *
 * 结果标签只为「查询」与「出错」开；脚本里几百条 insert 的更新行数只进「输出」，
 * 不然结果栏会被几百个标签撑爆。单条写语句仍给一个结果页，用来提示提交。
 *
 * `ignoreErrors` 给「回放 .sql 文件」用：迁移脚本里一条失败不该让后面全都不跑，
 * 但失败必须逐条记下来（`failures`），否则用户看到「跑完了」却不知道漏了什么。
 */
export async function runStatements(
  tabId: string,
  stmts: SqlRunTarget[],
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const outcome: RunOutcome = { failLine: null, failures: [], done: 0, stoppedByUser: false };
  const tab = sqlTabOf(tabId);
  if (!tab || tab.running || stmts.length === 0) return outcome;
  if (!tab.connId) {
    toast("先在工具条左边选一个连接", "warning");
    return outcome;
  }
  if (operationActive("db." + dbTxKey(tab.connId, tab.slot)) ||
    (tab.slot ? tab.txNotice : rtOf(tab.connId).txNotice)?.kind === "lost") return outcome;
  const connId = tab.connId;let stopRequested=false;
  const task=beginOperation({...dbTaskSpec(`sql:${tabId}`,"执行 SQL",connId,tab.slot ? `独立会话 ${tab.slot}` : `SQL 标签 ${tab.title}`,connOf(connId)?.name,tabId),phase:"检查连接与执行范围",cancel:async()=>{const active=sqlTabOf(tabId);if(active?.connId!==connId) throw new Error("来源标签已关闭或切换");stopRequested=true;try {if(active.running) await dbApi.cancel(connId,active.slot);}catch(e){stopRequested=false;throw e;}}});
  if(!task) return outcome;
  patchTab<SqlTab>(tabId, { executionId:task.id });
  // 本次执行的身份 / epoch：executionId 唯一，切连接、断开或发起新执行都会让它失效。
  // 之后所有写回（含 previousResults）都先复核，避免旧库的行落到新连接的标签上。
  const sameRun = () => {
    const cur = sqlTabOf(tabId);
    if (!cur || cur.connId !== connId || cur.executionId !== task.id) return false;
    // 不再比 slot：`execOne` 自己会在槽被空闲回收（`slot-gone`）后重开一条，那是合法换槽。
    // 拿换槽判「本次执行已失效」会把已经成功的结果整批丢掉、后续语句也不再跑，
    // 界面上是「已执行 0 / N 条」，而语句其实都执行了（历史与输出区里都有）。
    return true;
  };
  try {if (!(await ensureConnected(connId))) {task.finish("cancelled","连接未建立，语句未执行");return outcome;}}
  catch {task.finish("failed","连接未建立，返回数据库页查看原因");return outcome;}
  if(stopRequested) {task.finish("cancelled","执行请求尚未发出，语句未执行");outcome.stoppedByUser=true;return outcome;}
  if(sqlTabOf(tabId)?.connId!==connId) {task.finish("cancelled","来源标签或连接已切换，语句未执行");return outcome;}
  const previousResults = tab.results;
  const runConn = connOf(connId), runSchema = rtOf(connId).currentSchema ?? rtOf(connId).info?.schema;
  const contexts = stmts.map(statement => captureResultContext(connId, runConn, runSchema, statement.text, statement));
  setTxNotice(connId, tab.slot, tab.id);
  patchTab<SqlTab>(tabId, { running: true });
  const kept: ResultEntry[] = [];
  let ddl = false;
  let lastProgress = -Infinity;
  try {
    for (let i = 0; i < stmts.length; i++) {
      if(stopRequested) {outcome.stoppedByUser=true;break;}
      // 每条开始前重取标签：执行期间切连接 / 换槽 / 起了新执行，旧结果一律不再写回。
      if (!sameRun()) break;
      const s = stmts[i];
      // 回放进度每条都推进；节流只作用于任务中心的 task.update，避免频繁改 store。
      opts.onProgress?.({ done: i, total: stmts.length, line: s.startLine, text: s.text });
      const now = performance.now();
      if (now - lastProgress >= 125) {
        lastProgress = now;
        task.update({phase:`执行第 ${i+1} / ${stmts.length} 条`,progress:{done:i,total:stmts.length}});
      }
      if (isWrite(s.text) && !(await confirmProdWrite(tabId, connId, s.text))) {
        if (!sameRun()) break;
        appendOutput(tabId, [{ at: Date.now(), text: `第 ${i + 1} 条未执行：已取消`, tone: "info" }]);
        outcome.stoppedByUser = true;
        break;
      }
      if(stopRequested) {outcome.stoppedByUser=true;break;}
      const r = await execOne(tabId, s.text, i + 1, contexts[i], opts.collectStats);
      // await 期间可能已经切连接：这条结果属于旧库，丢弃且不继续写回。
      if (!sameRun()) break;
      const connectionInterrupted = r.errorCode === "session-lost" || r.errorCode === "fallback-session-lost" || r.errorCode === "probe-failed";
      r.startLine=s.startLine;
      if(r.cancelled) outcome.stoppedByUser = true;
      outcome.done = i + 1;
      if (r.kind !== "error" && stmtKind(s.text) === "ddl") ddl = true;
      if (r.kind !== "update" || stmts.length === 1) {
        if (kept.length === 0 && (connectionInterrupted || r.cancelled)) {
          kept.push(...previousResults.filter((result) => result.kind !== "error"));
        }
        kept.push(r);
        patchTab<SqlTab>(tabId, { results: [...kept], view: r.id });
        // Keep the script's own references bounded too, not just the store snapshot.
        const retained = sqlTabOf(tabId)?.results;
        if (retained) kept.splice(0, kept.length, ...retained);
      }
      if (r.kind === "error") {
        // PL/SQL 块的 `line N` 是相对这条语句的，加上起始行偏移才能落到编辑器真正的行
        const rel = plsqlErrorLine(r.error ?? "");
        const line = rel ? s.startLine + rel - 1 : s.startLine;
        outcome.failures.push({
          index: i + 1,
          line,
          text: s.text,
          error: r.error ?? "执行失败",
        });
        if (outcome.failLine === null) outcome.failLine = line;
        if (r.cancelled || connectionInterrupted || !opts.ignoreErrors) break;
      }
    }
  } catch(error) {
    task.finish("failed",`执行中断；已执行 ${outcome.done} 条，返回数据库页核对`);
    throw error;
  } finally {
    task.update({progress:{done:outcome.done,total:stmts.length}});
    task.finish(outcome.stoppedByUser ? "cancelled" : outcome.failures.length ? "failed" : "success",`已执行 ${outcome.done} / ${stmts.length} 条${outcome.failures.length ? `，失败 ${outcome.failures.length} 条` : ""}；写入状态以连接详情与提交/回滚按钮为准`);
    if (sameRun()) patchTab<SqlTab>(tabId, { running: false, ...(kept.length === 0 && !outcome.stoppedByUser ? { results: [], view: "output" } : {}) });
  }
  // 建表 / 改表之后侧栏与补全要跟上
  if (ddl) void loadMeta(connId);
  return outcome;
}

export async function explain(tabId: string, sql: string) {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId || !sql.trim() || operationActive("db." + dbTxKey(tab.connId, tab.slot))) return;
  if (!(await ensureConnected(tab.connId))) return;
  await explainInto(tabId, sql);
}
