import { ask, askUnsavedFiles } from "./dbConfirm";
import { dbApi } from "./dbApi";
import { getDb, loadConns } from "./dbStore";
import { mergePending } from "./quitGuard";
import { pendingDbSessions } from "./dbPendingSessions";
import { requestOpenFile } from "./openFileRequest";
import { friendlyDbError } from "./db";
import { isUnsaved } from "./tabDirty";
import { getSession } from "./workspaceSession";
import { toast } from "../components/ui/toast";
import { waitForFileOperations } from "./operations";

/**
 * 结束进程前（退出 / 更新重启 / 切工作区）的保存预检。
 *
 * **为什么单独成模块**：退出守卫、更新重启、切换工作区原本是三套流程；退出守卫
 * 会保存文件并处理事务，另外两条却直接丢会话。Windows 安装器会关闭进程，
 * 因此更新必须在启动安装器之前检查，而不能等安装完成后再检查。
 *
 * 动态 import 的原因同 `quitGuard`：`saveAllDirty → fileSave → editorStore → monacoSetup`
 * 会把整个 Monaco 绑进启动路径，不能在普通页面里静态引入。
 */
type SaveMod = typeof import("./saveAllDirty");

let saveAllMod: Promise<SaveMod> | null = null;
const loadSaveAll = () => (saveAllMod ??= import("./saveAllDirty"));

function revealFailed(path: string) {
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
  requestOpenFile({ path });
}

/**
 * 有未保存文件时弹框（保存全部 / 不保存 / 取消）。
 *
 * `action` 只影响文案：退出、更新重启、切换工程走的都是这一套，
 * 按钮上写错的动词会直接决定用户敢不敢点。
 *
 * 返回 false = 用户取消，或「保存全部」有文件失败——两种都应当中止当前动作。
 * 保存失败时把人送到第一个出问题的文件，和退出守卫的行为保持一致。
 */
export async function ensureFilesSaved(action = "退出", required = false): Promise<boolean> {
  await waitForFileOperations();
  // 快路径：会话里一个脏标签都没有就不可能丢东西，直接放行。
  // 不先做这一步的话，每次切工程/退出都要为「空集合」把整条保存链
  // （saveAllDirty → fileSave → editorStore → monaco）动态加载一遍——那是一次
  // 真金白银的模块加载，动作会被它拖延几十毫秒。`isUnsaved` 只依赖类型，
  // 静态引进来不会把 Monaco 拉进启动路径。
  if (!getSession().tabs.some(isUnsaved)) return true;

  let files: import("./saveAllDirty").UnsavedFile[] = [];
  try {
    files = (await loadSaveAll()).collectUnsaved();
  } catch (e) {
    // 能走到这里，说明上面第 49 行的静态扫描已经确认**有脏标签**（没有的话
    // 早就走快路径返回 true 了）。检查模块加载失败不等于「没有问题」：一律
    // 中止，不区分 required——过去 `return !required` 让切工程直接放行，
    // applyWorkspace 随即清空 tabs，未保存内容静默丢失（P0-2）。
    console.error("[preflight] 未保存文件检查不可用：", e);
    toast(`未保存文件检查失败，已中止${action}。请先手动保存后重试：${e}`, "error");
    return false;
  }
  if (files.length === 0) return true;

  const firstFailed: { path: string | null } = { path: null };
  const choice = await askUnsavedFiles(files, (onProgress) =>
    loadSaveAll()
      .then((m) => m.saveAllDirty(onProgress))
      .then((r) => {
        if (r.failed.length > 0) firstFailed.path = r.failed[0].path;
        return r.failed;
      }),
    action,
    !required,
  );
  if (choice === "cancel") {
    if (firstFailed.path) revealFailed(firstFailed.path);
    return false;
  }
  if (required && choice !== "save") toast("请先保存文件后再安装更新", "warning");
  return choice === "save" || !required;
}

/**
 * 更新安装前：运行任务 → 文件 → 未提交事务，下载期间新增的修改也在此检查。
 *
 * 返回 false = 用户取消 / 保存失败 / 提交回滚失败，调用方必须放弃重启。
 */
export async function prepareRestart(): Promise<boolean> {
  const { isNcTaskRunning } = await import("./ncTasks");
  const hasRunningWork = () => getSession().compiling || isNcTaskRunning() || getDb().tabs.some(tab =>
    tab.kind === "sql" ? tab.running : tab.kind === "dict" ? tab.state.running : false,
  );
  if (hasRunningWork()) {
    toast("编译、数据库或 NC 任务仍在运行，请完成后再安装更新", "warning");
    return false;
  }
  if (!(await ensureFilesSaved("安装更新", true))) return false;

  let rows: import("./dbConfirm").QuitRow[] = [];
  try {
    if (!getDb().loaded) await loadConns();
    if (getDb().loadError) throw new Error(getDb().loadError!);
    rows = mergePending(await dbApi.pendingTx());
  } catch (e) {
    // 探测失败不等于没有事务：保守地停下来，不能带着未知状态重启。
    toast(`检查未提交事务失败：${friendlyDbError(e)}`, "error");
    return false;
  }
  const db = getDb();
  const sessions = db.conns.flatMap(conn => pendingDbSessions(db, conn.id).map(session => `${conn.name} · ${session.label}`));
  if (rows.length || sessions.length) {
    // 事务选择属于各会话：更新不能代用户对多个库批量提交或回滚。
    const names = [...new Set([...rows.map(row => row.name), ...sessions])];
    const go = await ask("安装前，请处理数据库事务", `${names.slice(0, 8).join("、")}${names.length > 8 ? "等" : ""}仍有未提交事务或状态未知。请逐会话核对并提交或回滚，再从更新徽章继续。`, "返回数据库");
    if (go) window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "db" }));
    return false;
  }
  // 保存与事务探测会让出控制权；期间又开始工作时不能按旧快照放行。
  if (hasRunningWork() || getSession().tabs.some(isUnsaved)) {
    toast("当前工作状态已变化，请保存并完成任务后再继续更新", "warning");
    return false;
  }
  return true;
}
