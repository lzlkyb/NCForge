import { askQuit, askUnsavedFiles, type QuitChoice } from "./dbConfirm";
import { dbApi } from "./dbApi";
import { getDb, loadConns } from "./dbStore";
import { mergePending } from "./quitGuard";
import { requestOpenFile } from "./openFileRequest";
import { friendlyDbError } from "./db";
import { toast } from "../components/ui/toast";

/**
 * 结束进程前（退出 / 更新重启 / 切工作区）的保存预检。
 *
 * **为什么单独成模块**：退出守卫、更新重启、切换工作区原本是三套流程；退出守卫
 * 会保存文件并处理事务，另外两条却直接丢会话。更新安装完成后是 8 秒自动重启，
 * 用户来不及反应——这条路径必须和点 X 一样先保存、先确认未提交事务。
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
export async function ensureFilesSaved(action = "退出"): Promise<boolean> {
  let files: import("./saveAllDirty").UnsavedFile[] = [];
  try {
    files = (await loadSaveAll()).collectUnsaved();
  } catch (e) {
    // 编辑器模块没起来时不可能有编辑中的文件；不能因为预检不可用而卡住动作。
    console.error("[preflight] 未保存文件检查不可用，跳过：", e);
    return true;
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
  );
  if (choice === "cancel") {
    if (firstFailed.path) revealFailed(firstFailed.path);
    return false;
  }
  return true;
}

/**
 * 更新重启前：文件 → 未提交事务，顺序与退出守卫相同（快的本地保存在前）。
 *
 * 返回 false = 用户取消 / 保存失败 / 提交回滚失败，调用方必须放弃重启。
 */
export async function prepareRestart(): Promise<boolean> {
  if (!(await ensureFilesSaved())) return false;

  if (!getDb().loaded) await loadConns();
  let rows: import("./dbConfirm").QuitRow[] = [];
  try {
    rows = mergePending(await dbApi.pendingTx());
  } catch (e) {
    // 探测失败不等于没有事务：保守地停下来，不能带着未知状态重启。
    toast(`检查未提交事务失败：${friendlyDbError(e)}`, "error");
    return false;
  }
  if (rows.length === 0) return true;

  const choice: QuitChoice = await askQuit(rows);
  if (choice === "cancel") return false;
  try {
    for (const r of rows.filter((x) => x.kind === "pending")) {
      await dbApi.txAll(r.connId, choice);
    }
    return true;
  } catch (e) {
    toast(
      `重启前${choice === "rollback" ? "回滚" : "提交"}失败：${friendlyDbError(e)}`,
      "error",
    );
    return false;
  }
}
