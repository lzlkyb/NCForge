import { invoke, listen } from "./tauri";
import { trackOperation } from "./operations";
import { dbTaskSpec } from "./dbOperations";
import { dbApi, type PendingTxRow } from "./dbApi";
import { askQuit, askUnsavedFiles, askUnknownTx, type QuitChoice, type QuitRow } from "./dbConfirm";
import { connOf, getDb, loadConns, rtOf } from "./dbStore";
import { friendlyDbError } from "./db";
import { requestOpenFile } from "./openFileRequest";
import type { UnsavedFile } from "./saveAllDirty";
import { isUnsaved } from "./tabDirty";
import { getSession } from "./workspaceSession";
import { toast } from "../components/ui/toast";

/**
 * 退出守卫：点 X 之后、进程真正退出之前的那一步。
 *
 * **为什么需要它**：应用是「关窗即退出」（没有托盘、不常驻后台），进程一结束：
 * - Oracle 会话跟着断，未提交的写入被隐式回滚；
 * - 编辑器里的修改只在 Monaco model 里（工作区标签**不**持久化），直接没了。
 * 用户点一下 X 就把刚做的批量更新和一上午的改动丢掉，还没有任何提示。这里就是那个提示。
 *
 * **查两类东西，顺序是文件 → 事务**：
 * - 文件保存是本地磁盘操作，通常几十毫秒；事务探测要经过网络，可能几秒。
 *   把慢的放最后，用户等待时看到的是「正在保存」，而不是点完就卡住。
 *
 * **为什么事务两边都要查**：
 * - 后端 `db_pending_tx` 是权威：引擎句柄与事务计数在 Rust 侧，界面卡死也照样准；
 * - 前端 `rt.tx` 更及时：刚执行完还没回传的那一条，只有界面知道。
 *   同一连接取语句数大的那份（见 `mergePending`）。
 *
 * **时序**（后端在 `commands/quit_cmds.rs`，两边的注释要一起看）：
 * 1. 后端拦住关窗、发 `app:quit-request`、起 5 秒兜底计时；
 * 2. 这里**第一件事**是 `quit_check_acked`——不回话就会被当成界面卡死强退，
 *    用户可能正在慢慢看弹框，也可能正在等 20 个文件写盘；
 * 3. 没有要处理的 → `app_quit` 直接放行；有 → 弹框 → 按选择做完再放行；
 * 4. 用户取消（或保存失败后选择回去处理）→ `quit_cancel` 复位，下次点 X 重新走一遍。
 */

let wired = false;
let inFlight = false;

/**
 * 按需加载「未保存文件」模块。
 *
 * **为什么用动态 import**：`saveAllDirty → fileSave → editorStore → monacoSetup`
 * 这条链会把整个 Monaco 及其 worker 拉进来。退出守卫在 `App` 挂载时就执行，
 * 静态引入等于把编辑器整包绑进启动路径与所有引用它的单测（node 环境加载
 * monaco 会直接报 `window is not defined`）。
 */
let saveAllMod: Promise<typeof import("./saveAllDirty")> | null = null;
function loadSaveAll() {
  saveAllMod ??= import("./saveAllDirty");
  return saveAllMod;
}

/**
 * 把后端（权威）与界面（更及时）两份事务状态合成一份待确认清单。
 *
 * 合并规则：
 * - 后端说 `unknown`（探测超时/连接已断）→ 保持 `unknown`，即使界面还有旧的事务
 *   数据——那份数据可能早就过时了，不能拿来当"可以提交"的依据；
 * - 两边都有 → 语句数与行数取大的（更保守），开始时间取早的（显示的持续时长更长）。
 */
export function mergePending(rows: PendingTxRow[]): QuitRow[] {
  const out = new Map<string, QuitRow>();

  for (const r of rows) {
    if (r.state === "clean") continue;
    const c = connOf(r.id);
    out.set(r.id, {
      connId: r.id,
      name: c?.name ?? r.id,
      env: c?.env ?? "other",
      kind: r.state,
      statements: r.statements ?? 0,
      rows: r.rows ?? 0,
      since: r.since ?? 0,
      message: r.message,
    });
  }

  for (const c of getDb().conns) {
    const tx = rtOf(c.id).tx;
    // 自动提交模式下每条语句都已落盘，退出不会丢东西 → 不算待确认
    if (!tx || tx.autoCommit || tx.statements <= 0) continue;
    const cur = out.get(c.id);
    if (!cur) {
      out.set(c.id, {
        connId: c.id,
        name: c.name,
        env: c.env,
        kind: "pending",
        statements: tx.statements,
        rows: tx.rows,
        since: tx.since,
      });
      continue;
    }
    if (cur.kind !== "pending") continue;
    cur.statements = Math.max(cur.statements, tx.statements);
    cur.rows = Math.max(cur.rows, tx.rows);
    if (tx.since && (!cur.since || tx.since < cur.since)) cur.since = tx.since;
  }

  return [...out.values()];
}

/**
 * 保存失败后把用户送到第一个出问题的文件上：切到文件页并打开它。
 *
 * 顺序不能反：先切页再请求打开——`FilesTab` 是懒加载组件，切页之前它可能还没挂载，
 * 那时请求会存进 `openFileRequest` 的 pending 槽位，等它挂载后自己取走。
 */
function revealFailed(path: string) {
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
  requestOpenFile({ path });
}

async function handleQuitRequest() {
  // 同一轮的重投（确认框还开着时用户又点了一次 X）：后端只重发事件、不再起计时器。
  // 这里**必须重发 ack**——静默 return 会让 5 秒兜底误判「界面没回话」而强退，
  // 把未保存的 model 与全部未提交事务一起丢掉（P0-1）。
  if (inFlight) {
    await invoke("quit_check_acked").catch(() => undefined);
    return;
  }
  inFlight = true;

  /** 事务阶段选了什么（失败时用来报对话）；null = 还没走到事务阶段。 */
  let txChoice: QuitChoice | null = null;
  /**
   * 「保存全部」失败的第一个文件。用对象持有而不是裸 `let`：闭包里赋值时
   * TS 的控制流分析不会跟踪，裸变量在 `if` 里会被收窄成 `null` 而报错。
   */
  const firstFailed: { path: string | null } = { path: null };

  try {
    // 第一件事：告诉后端「我活着，正在查」，停掉它的兜底强退计时。
    // 失败也不能中断流程——那只是让 5 秒计时继续走。
    await invoke("quit_check_acked").catch(() => undefined);

    // ① 编辑器里未保存的修改。数据源是 workspaceSession（模块级），
    //    和页面有没有挂载、用户在哪个页签无关。
    let files: UnsavedFile[] = [];
    try {
      files = (await loadSaveAll()).collectUnsaved();
    } catch (e) {
      // 「检查跑不起来」不等于「没有未保存文件」：tab/model 是 workspaceSession
      // 的模块级状态，跟这个动态 chunk 能不能加载成功无关（打包异常 / HMR 中断
      // 时照样存在脏标签）。用不依赖 Monaco 的静态 isUnsaved 再扫一遍，只要有
      // 脏标签就中止退出，绝不静默放行（P0-2）。
      const dirty = getSession().tabs.filter(isUnsaved).length;
      console.error("[quitGuard] 未保存文件检查不可用：", e);
      if (dirty > 0) {
        toast(
          `未保存文件检查失败（当前有 ${dirty} 个未保存文件），已取消退出。请手动保存后重试：${e}`,
          "error",
        );
        await invoke("quit_cancel");
        return;
      }
      // 静态扫描确认一个脏标签都没有：这次加载失败不会丢东西，继续查事务。
    }
    if (files.length > 0) {
      // 保存动作也走同一个已缓存的 import：能列文件说明它已经加载成功了
      const choice = await askUnsavedFiles(files, (onProgress) =>
        loadSaveAll()
          .then((m) => m.saveAllDirty(onProgress))
          .then((r) => {
            if (r.failed.length > 0) firstFailed.path = r.failed[0].path;
            return r.failed;
          }),
      );
      if (choice === "cancel") {
        // 从「保存失败」退回来的：把人送到那个文件上，别让他自己满世界找。
        // 主动点「取消」的（firstFailed 为空）就留在原处，什么都不动。
        if (firstFailed.path) revealFailed(firstFailed.path);
        await invoke("quit_cancel");
        return;
      }
    }

    // ② 数据库未提交事务
    // 弹框要显示连接名，没加载过就先拉一次（只在首启/异常路径会走到）
    if (!getDb().loaded) await loadConns();

    const rows = mergePending(await dbApi.pendingTx());
    if (rows.length === 0) {
      await invoke("app_quit");
      return;
    }

    txChoice = await askQuit(rows);
    if (txChoice === "cancel") {
      await invoke("quit_cancel");
      return;
    }

    // 只动探测到状态的连接。这里必须显式收集 unknown：整批探测超时时 rows
    // 可能全是 unknown，下面 filter 之后循环体一次都不执行，直接 app_quit
    // 会让用户以为「全部提交」成功了，实际一条都没提交（P0-4）。
    const unknown = rows.filter((x) => x.kind === "unknown");
    for (const r of rows.filter((x) => x.kind === "pending")) {
      // 一个连接上可能有多条独立会话（A0 的槽）：必须由后端把 primary 与全部槽
      // 一起处理。只提交 primary 等于把槽里的写入静默回滚——那正是这个守卫存在的原因。
      await trackOperation(dbTaskSpec(`quit.txAll:${r.connId}`, `退出前${txChoice === "rollback" ? "回滚" : "提交"}事务`, r.connId, "全部会话"),()=>dbApi.txAll(r.connId, txChoice as "commit"|"rollback"));
    }
    // 状态未知的连接无法提交也无法回滚，退出后必然被数据库回滚：必须再问一次，
    // 不能让「全部提交」这个按钮替用户做出他不知情的决定。
    if (unknown.length > 0 && !(await askUnknownTx(unknown))) {
      await invoke("quit_cancel");
      return;
    }
    await invoke("app_quit");
  } catch (e) {
    // 提交/回滚失败就**留在应用里**：报错让用户重来，不能假装成功再退出。
    // 文件保存的失败不会走到这里——那些在弹框里就地列出了。
    const msg = txChoice
      ? `退出前${txChoice === "rollback" ? "回滚" : "提交"}失败：${friendlyDbError(e)}`
      : `退出前处理失败：${e}`;
    toast(msg, "error");
    void invoke("quit_cancel").catch(() => undefined);
  } finally {
    inFlight = false;
  }
}

/**
 * 挂上退出监听（幂等，全局只需一次，由 `App` 在挂载时调）。
 * 返回 teardown；浏览器里跑 vite dev 时 listen 会失败，忽略即可。
 */
export function wireQuitGuard(): () => void {
  if (wired) return () => {};
  wired = true;

  let un: (() => void) | undefined;
  let unGuardError: (() => void) | undefined;
  let disposed = false;
  const attach = (event: string, handler: () => void, set: (fn: () => void) => void) => {
    listen(event, handler)
      .then((fn) => {
        if (disposed) fn();
        else set(fn);
      })
      .catch(() => {});
  };
  attach("app:quit-request", () => void handleQuitRequest(), (fn) => {
    un = fn;
  });
  // Rust 侧 emit 失败时会保持窗口（不再静默放行退出）。这里把「点了 X 没反应」
  // 的原因与代价讲清楚，否则用户只会以为应用卡死。
  attach(
    "app:quit-guard-error",
    () => toast(
      "退出前检查无法启动，已阻止关闭窗口。请先手动保存文件并提交或回滚事务后重试；若强制结束进程，未提交事务会被数据库回滚。",
      "error",
    ),
    (fn) => {
      unGuardError = fn;
    },
  );

  return () => {
    disposed = true;
    un?.();
    unGuardError?.();
    wired = false;
  };
}
