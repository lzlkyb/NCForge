import { useSyncExternalStore } from "react";
import { connOf, connect, getDb, rtOf, txAction } from "./dbStore";
import { friendlyDbError } from "./db";
import type { DbEnv, TxInfo } from "./dbApi";
import type { SaveFailure, UnsavedFile } from "./saveAllDirty";
import { toast } from "../components/ui/toast";

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
  | { kind: "tx"; connId: string; reason: string; tx: TxInfo; resolve: (c: TxChoice) => void }
  | { kind: "quit"; rows: QuitRow[]; resolve: (c: QuitChoice) => void }
  | {
      kind: "unsavedFiles";
      files: UnsavedFile[];
      /** 「保存全部并退出」真正做事的入口，由 `quitGuard` 注入；返回还失败的那些。 */
      onSave: (onProgress: (done: number, total: number) => void) => Promise<SaveFailure[]>;
      resolve: (c: FileQuitChoice) => void;
    }
  | { kind: "prod"; connId: string; tabId: string; sql: string; resolve: (ok: boolean, quiet: boolean) => void }
  | { kind: "password"; connId: string; error: string | null; resolve: (r: { password: string; remember: boolean } | null) => void }
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
  show(null);
  if (p) run(p);
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
): Promise<FileQuitChoice> {
  return new Promise((resolve) => show({ kind: "unsavedFiles", files, onSave, resolve }));
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

const hasOpenTx = (connId: string) => (rtOf(connId).tx?.statements ?? 0) > 0;

/**
 * 离开一个连接前（关标签 / 切到别的连接 / 断开）检查未提交事务。
 * 返回 false = 用户取消或提交失败，调用方应当停下。
 */
export async function guardTx(connId: string | null, reason: string): Promise<boolean> {
  if (!connId || !hasOpenTx(connId)) return true;
  const choice = await new Promise<TxChoice>((resolve) =>
    show({ kind: "tx", connId, reason, tx: rtOf(connId).tx!, resolve }),
  );
  if (choice === "cancel") return false;
  try {
    await txAction(connId, choice);
    return true;
  } catch (e) {
    toast(`${choice === "commit" ? "提交" : "回滚"}失败：${friendlyDbError(e)}`, "error");
    return false;
  }
}

/** 只有「这个标签是该连接上最后一个标签」时才需要处理事务：别的标签还在用同一个会话。 */
export function isLastTabOn(connId: string | null, tabId: string): boolean {
  if (!connId) return false;
  return !getDb().tabs.some((t) => t.id !== tabId && t.connId === connId);
}

const quietUntil = new Map<string, number>();

/** 生产库执行写语句前确认。「10 分钟内不再询问」按标签记。 */
export async function confirmProdWrite(tabId: string, connId: string, sql: string): Promise<boolean> {
  if (connOf(connId)?.env !== "prod") return true;
  if ((quietUntil.get(tabId) ?? 0) > Date.now()) return true;
  return new Promise<boolean>((resolve) =>
    show({
      kind: "prod",
      connId,
      tabId,
      sql,
      resolve: (ok, quiet) => {
        if (ok && quiet) quietUntil.set(tabId, Date.now() + 10 * 60_000);
        resolve(ok);
      },
    }),
  );
}

/** 确保连上：需要口令就弹框，口令错了可以重输；用户取消返回 false。 */
export async function ensureConnected(connId: string): Promise<boolean> {
  const rt = rtOf(connId);
  if (rt.status === "connected") return true;
  if (rt.status === "connecting") return false;
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
