import { saveOne } from "./fileSave";
import { applySaved } from "./tabSession";
import { getSession, setSession, type TabMeta } from "./workspaceSession";
import { cleanError, isConflictError, isUnencodableError } from "./workspace";

/**
 * 「退出前把编辑器里的修改存一遍」。
 *
 * 数据源是 `workspaceSession`（模块级），不是 React 状态：退出流程由 `quitGuard`
 * 驱动，那会儿没有组件在渲染，也拿不到 `FilesTab` 的闭包。
 *
 * 只处理**真实文件**：`jdt://` 虚拟标签只读、`readOnly` 的标签（混合换行 / 编码
 * 不可无损往返）编辑器本身就锁着，两者都不可能真的「有修改没保存」。
 * `eolChanged` 也算未保存——内容没变，但保存后行尾会跟着改，同样是用户还没落盘的意图。
 */

/** 弹框里要列的一行。字段足够画出「这是哪个文件」，不含内容。 */
export interface UnsavedFile {
  path: string;
  name: string;
  /** 预览标签（文件树单击打开、还没固定）：只改过但没双击过，路径可能被下次单击顶掉。 */
  preview: boolean;
}

/** 保存失败的一个文件。`reason` 是给用户看的一句话，不是原始错误串。 */
export interface SaveFailure {
  path: string;
  name: string;
  reason: string;
}

export interface SaveAllResult {
  saved: string[];
  failed: SaveFailure[];
}

/** 该文件的修改是否需要用户处理（与 `FilesTab` 的 `hasUnsaved` 同一口径）。 */
export function isUnsaved(t: TabMeta): boolean {
  return !t.readOnly && !t.virtual && (t.dirty || t.eolChanged);
}

/** 当前所有等待落盘的文件。没有它就是「直接退出，不用问」。 */
export function collectUnsaved(): UnsavedFile[] {
  return getSession()
    .tabs.filter(isUnsaved)
    .map((t) => ({ path: t.path, name: t.name, preview: !!t.preview }));
}

/**
 * 错误翻译成一句话。
 *
 * 冲突要单独说：用户点「保存全部并退出」时如果磁盘被别人改过，正确做法是
 * **停下来让他处理**，而不是替他决定覆盖。所以这里给出可执行的提示，
 * 调用方也不会自动 force 重试。
 */
function reasonOf(e: unknown): string {
  if (isConflictError(e)) return "文件已被其他程序修改，需要先处理冲突";
  if (isUnencodableError(e)) return "含当前编码写不出的字符（可转成 UTF-8 保存）";
  return cleanError(e);
}

/**
 * 逐个保存所有未保存的文件。
 *
 * 单个失败不中断：把失败收集起来一起返回，用户一次看到全部问题，
 * 而不是修一个再点一次 X 发现还有下一个。
 */
export async function saveAllDirty(
  onProgress?: (done: number, total: number) => void,
): Promise<SaveAllResult> {
  const targets = collectUnsaved();
  const saved: string[] = [];
  const failed: SaveFailure[] = [];

  for (let i = 0; i < targets.length; i += 1) {
    const f = targets[i];
    onProgress?.(i + 1, targets.length);
    // 每次从最新会话取标签：上一条保存会改掉 mtime / readOnly / eolChanged，
    // 用循环外面那份快照会带着过期的 mtime 触发误判冲突
    const tab = getSession().tabs.find((t) => t.path === f.path);
    if (!tab || !isUnsaved(tab)) {
      saved.push(f.path);
      continue;
    }
    try {
      const r = await saveOne(tab);
      setSession({ tabs: (ts) => applySaved(ts, f.path, r) });
      saved.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, name: f.name, reason: reasonOf(e) });
    }
  }

  return { saved, failed };
}
