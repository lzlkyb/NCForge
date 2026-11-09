import { useSyncExternalStore } from "react";
import { claimCursor, connOf, connect, getDb, patchTab, rtOf, setTx, setTxNotice, sqlTabOf, txAction, type SqlTab } from "./dbStore";
import { friendlyDbError, parseDbError } from "./db";
import type { DbEnv, TxInfo } from "./dbApi";
import { dbApi } from "./dbApi";
import type { SaveFailure, UnsavedFile } from "./saveAllDirty";
import { toast } from "../components/ui/toast";
import { operationActive } from "./operations";
import { dbTxKey } from "./dbOperations";
import { txPending } from "./txState";

/**
 * 几个「要停下来问一句」的地方，统一成 Promise：
 * - 退出应用时还有**编辑器修改没保存**：三选一（保存全部并退出 / 不保存 / 取消）；
 * - 未提交事务：关标签 / 切连接 / 断开时三选一（提交 / 回滚 / 取消）；
 * - 退出应用时还有未提交事务：同上（见 `quitGuard`）；
 * - 生产库写语句：执行前确认一次；
 * - 口令：连接没存口令或口令错了时补输。
 *
 * 弹框由 `DbConfirmHost` 渲染（挂在 `App` 上，任何页面都能弹）；调用方只管
 * `await`，不用各自维护弹框状态。
 */

export type TxChoice = "commit" | "rollback" | "cancel";
export type QuitChoice = TxChoice;
/** 未保存文件弹框的三种结果。`save` 只在**真的全部保存成功**时返回。 */
export type FileQuitChoice = "save" | "discard" | "cancel";

/** 弹框里的一条保存失败记录（结构同 `saveAllDirty` 的 `SaveFailure`）。 */
export type { SaveFailure, UnsavedFile };

/** 退出确认框里的一行。连接名/环境已由 `quitGuard` 合并好，弹框不再查 store。 */
export interface QuitRow {
  connId: string;
  name: string;
  env: DbEnv;
  /** `unknown` = 探测超时或连接已断，提交/回滚都可能失败。 */
  kind: "pending" | "unknown";
  statements: number;
  rows: number;
  since: number;
  message?: string;
}

export type Pending =
  | {
      kind: "tx";
      connId: string;
      reason: string;
      tx: TxInfo;
      /** A0 独立会话槽：`guardSlotTx` 传槽，primary 走 `guardTx` 不传。 */
      slot?: string | null;
      /** 提交/回滚进行中：留在框里显示进度，期间禁止取消或关闭。 */
      busy?: TxChoice | null;
      resolve: (c: TxChoice) => void;
    }
  | { kind: "quit"; rows: QuitRow[]; resolve: (c: QuitChoice) => void }
  | {
      kind: "unsavedFiles";
      files: UnsavedFile[];
      /** 这一步叫「退出」还是「切换工程」——按钮与正文都要说得对。 */
      action: string;
      /** 更新安装要求先保存，不能提供会丢失修改的继续入口。 */
      allowDiscard?: boolean;
      /** SVN 提交保留编辑器草稿；不能使用退出时“修改会丢失”的说明。 */
      purpose?: "svn";
      /** 保存尚未收尾时 Escape 不能提前释放调用方的工作保护锁。 */
      saving?: boolean;
      /** 「保存全部并退出」真正做事的入口，由 `quitGuard` 注入；返回还失败的那些。 */
      onSave: (onProgress: (done: number, total: number) => void) => Promise<SaveFailure[]>;
      resolve: (c: FileQuitChoice) => void;
    }
  | { kind: "prod"; connId: string; tabId: string; sql: string; resolve: (ok: boolean, quiet: boolean) => void }
  | { kind: "password"; connId: string; error: string | null; temporary?: boolean; resolve: (r: { password: string; remember: boolean } | null) => void }
  | { kind: "ask"; title: string; message: string; ok: string; danger: boolean; resolve: (ok: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function show(p: Pending | null) {
  pending = p;
  listeners.forEach((fn) => fn());
}

export function usePending(): Pending | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => pending,
  );
}

/** 弹框里的按钮调它：先关框再回调，回调里可以接着弹下一个。 */
export function settle(run: (p: Pending) => void) {
  const p = pending;
  if (p?.kind === "unsavedFiles" && p.saving) return;
  // 提交/回滚进行中不允许「取消」「点遮罩」「ESC」把框关掉：动作还在跑，
  // 调用方却已经 resolve 成 cancel，用户会以为事务没动过。
  if (p?.kind === "tx" && p.busy) return;
  show(null);
  if (p) run(p);
}

/**
 * 提交 / 回滚按钮的统一入口：**留在框里**显示进行中，动作完成后才关闭并 resolve。
 *
 * 原先 `settle` 立即关框、调用方在框外 `await txAction`，生产库大事务几十秒里
 * 界面没有任何东西在动，用户以为没点上而重复触发关标签 / 退出（P1-12）。
 * 失败时也不关框：给出错误，让用户可以重试或改选回滚。
 */
export async function settleTx(choice: "commit" | "rollback"): Promise<void> {
  const p = pending;
  if (!p || p.kind !== "tx" || p.busy) return;
  p.busy = choice;
  listeners.forEach((fn) => fn());
  try {
    await txAction(p.connId, choice, p.slot ?? undefined);
    show(null);
    p.resolve(choice);
  } catch (e) {
    p.busy = null;
    listeners.forEach((fn) => fn());
    toast(`${choice === "commit" ? "提交" : "回滚"}失败：${friendlyDbError(e)}`, "error");
  }
}

/** 普通的是 / 否确认（删除连接等）。 */
export function ask(title: string, message: string, ok = "确定", danger = false): Promise<boolean> {
  return new Promise((resolve) => show({ kind: "ask", title, message, ok, danger, resolve }));
}

/**
 * 退出前的第一问：编辑器里还有没保存的文件。
 *
 * **为什么把 `onSave` 塞进弹框状态**：点「保存全部并退出」之后框不能关——
 * 保存要花时间（多个文件、大文件），关掉框会让人以为已经存好了；保存失败时
 * 更要就地列出是哪些文件、为什么失败。所以动作由弹框自己发起，进度和失败
 * 也由弹框自己显示，`quitGuard` 只提供实现。
 */
export function askUnsavedFiles(
  files: UnsavedFile[],
  onSave: (onProgress: (done: number, total: number) => void) => Promise<SaveFailure[]>,
  action = "退出",
  allowDiscard = true,
  purpose?: "svn",
): Promise<FileQuitChoice> {
  return new Promise((resolve) => {
    const request: Extract<Pending, { kind: "unsavedFiles" }> = {
      kind: "unsavedFiles", files, action, allowDiscard, purpose, resolve,
      onSave: async onProgress => {
        request.saving = true;
        try { return await onSave(onProgress); }
        finally { request.saving = false; }
      },
    };
    show(request);
  });
}

/**
 * 退出前的确认：列出所有还没提交的连接，一次决定全部。
 *
 * 为什么是「全部」粒度：退出这个场景下用户通常在赶时间，逐连接选只会让框变形；
 * 实际也很少出现两个库同时有事务。
 */
export function askQuit(rows: QuitRow[]): Promise<QuitChoice> {
  return new Promise((resolve) => show({ kind: "quit", rows, resolve }));
}

/**
 * 退出时还有状态未知的连接，必须**再问一次**。
 *
 * 整批探测超时时 rows 可能全是 `unknown`，`askQuit` 的「全部提交」按钮会让人
 * 以为事务都提交了，实际循环体一次都不执行。这里把「无法提交、退出即回滚」
 * 摆到用户面前，由他决定是否接受（P0-4）。
 */
export function askUnknownTx(rows: QuitRow[]): Promise<boolean> {
  const names = [...new Set(rows.map((r) => r.name))];
  const list = `${names.slice(0, 8).join("、")}${names.length > 8 ? " 等" : ""}`;
  return ask(
    "有连接的事务状态未知",
    `${list} 的未提交事务现在无法确认，也无法在这里提交或回滚；退出后会被数据库回滚，等同于没执行过。确定仍要退出吗？`,
    "仍要退出",
    true,
  );
}

// 判据统一走 `txPending`：核对过（`tx.active`）就以数据库真源为准，否则退回本地 DML 计数。
// 只看 `statements` 会把「手写 COMMIT 之后一直不归零」的连接永久卡在确认框里。
const hasOpenTx = (connId: string) => txPending(rtOf(connId).tx).pending;

/**
 * 离开一个连接前（关标签 / 切到别的连接 / 断开）检查未提交事务。
 * 返回 false = 用户取消或提交失败，调用方应当停下。
 */
export async function guardTx(connId: string | null, reason: string): Promise<boolean> {
  if (connId && operationActive("db." + dbTxKey(connId))) {
    toast("等待主会话事务操作结束", "info");
    return false;
  }
  if (!connId || !hasOpenTx(connId)) return true;
  const choice = await new Promise<TxChoice>((resolve) =>
    show({ kind: "tx", connId, reason, tx: rtOf(connId).tx!, resolve }),
  );
  if (choice === "cancel") return false;
  // 提交/回滚已由 `settleTx` 在弹框内执行完毕（失败则留在框里重试），
  // 这里不再重复执行一次 `txAction`。
  return true;
}

/**
 * 只有「这个标签是该连接上最后一个标签」时才需要处理事务：别的标签还在用同一个会话。
 *
 * 字典标签不算：它只查字典、不开会话，把「只剩字典标签」当成还有人守着会话，
 * 会让关掉最后一个 SQL 标签时静默丢掉未提交的 update。
 */
export function isLastTabOn(connId: string | null, tabId: string): boolean {
  if (!connId) return false;
  return !getDb().tabs.some((t) => t.id !== tabId && t.connId === connId && t.kind !== "dict");
}

/**
 * 关标签 / 换连接前查**这条会话槽**的未提交事务（A0：槽各自独立事务）。
 *
 * 为什么不能复用 `guardTx`：那个看的是连接的 primary 会话（`rt.tx`），
 * 而 SQL 标签跑在自己的槽里——primary 干净不代表槽里没有没提交的 update。
 * 漏了这一问，关标签就是静默回滚。
 *
 * 探测失败时**只有**错误码能证明「会话确实不存在」才放行；IPC 超时、bridge 忙、
 * SQL 异常、权限不足都可能是槽里还挂着未提交的 update，一律保守停下（P0-5）。
 */
const SAFE_TO_RELEASE_TX = new Set([
  "slot-gone",
  "session-lost",
  "fallback-session-lost",
  "not-connected",
]);

export async function guardSlotTx(
  connId: string | null,
  slot: string | null | undefined,
  reason: string,
): Promise<boolean> {
  if (!connId || !slot) return true;
  if (operationActive("db." + dbTxKey(connId, slot))) {
    toast("等待独立会话事务操作结束", "info");
    return false;
  }
  let tx: TxInfo;
  try {
    tx = (await dbApi.tx(connId, "status", slot)).tx;
  } catch (e) {
    // 空 catch 会把「检查不了」当成「没有事务」：网络闪断 / 后端忙 / 桥异常时
    // 槽里可能还有未提交的 update，关标签就是静默回滚。同仓 terminatePreflight
    // 与 quit_cmds 在探测失败时都保守停下，这里必须一致（P0-5）。
    const { code } = parseDbError(e);
    if (SAFE_TO_RELEASE_TX.has(code)) return true;
    toast(
      `${reason}前检查事务状态失败：${friendlyDbError(e)}。已中止操作，请稍后重试或先到数据库页手动核对未提交写入。`,
      "error",
    );
    return false;
  }
  if (!tx || !txPending(tx).pending) return true;
  const choice = await new Promise<TxChoice>((resolve) =>
    show({ kind: "tx", connId, reason, tx, slot, resolve }),
  );
  if (choice === "cancel") return false;
  // 动作已由 `settleTx` 在弹框内完成（含槽参数），这里不再重复执行。
  return true;
}

const quietUntil = new Map<string, number>();

/** 生产库执行写语句前确认。「10 分钟内不再询问」按标签记。 */
export async function confirmProdWrite(tabId: string, connId: string, sql: string): Promise<boolean> {
  if (connOf(connId)?.env !== "prod") return true;
  // 静默期按「标签 + 连接」记：只记标签的话，同一个 SQL 标签切到另一个生产库后
  // 会继承上一个库的免确认，对着第二个生产库写也不问了。
  const quietKey = `${tabId}:${connId}`;
  if ((quietUntil.get(quietKey) ?? 0) > Date.now()) return true;
  return new Promise<boolean>((resolve) =>
    show({
      kind: "prod",
      connId,
      tabId,
      sql,
      resolve: (ok, quiet) => {
        if (ok && quiet) quietUntil.set(quietKey, Date.now() + 10 * 60_000);
        resolve(ok);
      },
    }),
  );
}

/** 确保连上：需要口令就弹框，口令错了可以重输；用户取消返回 false。 */
export async function ensureConnected(connId: string): Promise<boolean> {
  const rt = rtOf(connId);
  if (rt.status === "connected") return true;
  if (rt.status === "connecting") {
    // 刚点完连接（还在转圈）就按 Ctrl+Enter：不能什么都不发生——用户会连点几次，
    // 而且连接建好之后也不会自动补跑这次执行。给一句话，让他知道该等一下。
    toast("正在连接，稍等一下再执行", "info");
    return false;
  }
  let r = await connect(connId);
  // 第一次弹框且本来就没存口令：不是「出错」，不显示红字
  let quiet = !connOf(connId)?.hasPassword;
  while (r === "need-password") {
    const err = quiet ? null : (rtOf(connId).error ?? null);
    quiet = false;
    const input = await new Promise<{ password: string; remember: boolean } | null>((resolve) =>
      show({ kind: "password", connId, error: err, resolve }),
    );
    if (!input) return false;
    r = await connect(connId, input.password, input.remember);
  }
  return r === "ok";
}

/**
 * 「按连接设置重连」的判定收敛在这里（P2-22）。
 *
 * 过去只有 TxBar 传 `configured`，DbErrorBox / TableData 走默认值，同一个重连
 * 动作两条入口的确认文案与后端参数不一致。判据用客观的「连接设置的提交方式
 * 与当前会话不一致」，跟 TxBar 的 `modeChanged` 同一口径；Java 兜底重连一律
 * 不按配置。`configured` 参数保留为可选覆盖，老调用方不用改。
 */
function shouldUseConfigured(
  connId: string,
  slot: string | null,
  tabId?: string,
  fallback = false,
): boolean {
  if (fallback) return false;
  const conn = connOf(connId);
  const tx = slot ? (tabId ? sqlTabOf(tabId)?.tx : undefined) : rtOf(connId).tx;
  return !!conn && !!tx && tx.autoCommit !== conn.autoCommit;
}

/** 重连只替换出故障的会话。旧事务的结果要先由用户核对。 */
export async function reconnectSession(connId: string, slot: string | null, tabId?: string, fallback = false, configured?: boolean): Promise<boolean> {
  const current = () => {
    if (!tabId) return true;
    const tab = sqlTabOf(tabId);
    return tab?.connId === connId && (tab.slot ?? null) === slot && !tab.running;
  };
  const useConfigured = configured ?? shouldUseConfigured(connId, slot, tabId, fallback);
  const detail = useConfigured ? "当前会话将采用连接设置中的提交方式，其他会话各自保留原设置。请先核对上一次操作和未提交事务的结果。"
    : "请先核对上一次操作和未提交事务的结果。重连后请确认当前 Schema 等会话设置，原 SQL 和已显示的结果仍可查看。";
  if (!(await ask("重新连接数据库", detail, "重新连接")) || !current()) return false;
  const reconnect = (password?: string) => useConfigured
    ? dbApi.reconnect(connId, slot, password, fallback, true)
    : dbApi.reconnect(connId, slot, password, fallback);
  let result;
  try {
    result = await reconnect();
  } catch (e) {
    const { code } = parseDbError(e);
    if (code !== "need-password" && code !== "auth") throw e;
    const input = await new Promise<{ password: string } | null>((resolve) =>
      show({ kind: "password", connId, error: code === "auth" ? friendlyDbError(e) : null, temporary: true, resolve }),
    );
    if (!input || !current()) return false;
    result = await reconnect(input.password);
  }
  const tx = { autoCommit: result.autoCommit, statements: 0, rows: 0, since: 0 };
  if (!fallback) {
    claimCursor(connId, slot, "reconnect");
    if (!slot) setTx(connId, tx);
    else if (tabId && current()) patchTab<SqlTab>(tabId, { tx });
    setTxNotice(connId, slot, tabId);
  }
  if (!useConfigured) toast("已重新连接，请按需手动执行 SQL", "success");
  return true;
}
