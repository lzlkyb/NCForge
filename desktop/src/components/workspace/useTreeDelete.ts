import { useRef, useState } from "react";
import { baseName, countFiles, deleteEntry, dirName } from "../../lib/workspace";
import { toast } from "../ui/toast";
import { failureText } from "../../lib/friendlyError";
import { checkReferences } from "../../lib/safeDelete";
import { isUnsaved } from "../../lib/tabDirty";
import { getSession, setTree, type TreeDirState } from "../../lib/workspaceSession";
import type { EncodingMark } from "../../lib/workspace";

/** 待确认的删除（目录要先数一下里面有多少文件，所以确认框是异步准备的）。 */
export interface PendingDelete {
  path: string;
  isDir: boolean;
  files: number;
  labels: number;
  /** 命中范围内「改过但没保存」的文件数：这些内容会随标签关闭一起消失。 */
  unsaved: number;
  /** 别处还提到这个类的地方（只对 .java 有意义，删除确认里提示用）。 */
  refs: number;
  refSamples: string[];
}

/** 删除流程：数文件 → 确认 → 删 → 清缓存 → 通知调用方关标签。 */
export function useTreeDelete({
  root,
  load,
  onDeleted,
  openPaths,
  setSelected,
}: {
  root: string;
  load: (path: string) => Promise<void>;
  onDeleted: (paths: string[]) => void;
  openPaths: string[];
  setSelected: (value: { path: string; isDir: boolean } | null) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // openPaths 只在弹删除确认时读一次；用 ref 存最新值，免得每次开标签都把整棵树的回调重建一遍
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;

  const askDelete = async (target: { path: string; isDir: boolean }) => {
    if (target.path === root) return;
    let files = 1;
    if (target.isDir) {
      try {
        files = await countFiles(target.path);
      } catch (e) {
        toast(failureText("读取文件数", e), "error");
        return;
      }
    }
    const lower = target.path.toLowerCase();
    const hit = (p: string) => {
      const pl = p.toLowerCase();
      return pl === lower || pl.startsWith(`${lower}\\`);
    };
    const labels = openPathsRef.current.filter(hit).length;
    // 「有个未保存的改动」必须单独说出来：只讲「不进回收站」只覆盖了磁盘那一半，
    // 用户手上那份没落盘的修改其实会随着标签关闭一起消失，而这往往是唯一的副本。
    // 判定复用 `lib/tabDirty.isUnsaved`（唯一口径）——它没有运行时依赖，静态引即可，
    // 不会把 Monaco 拖进文件树的模块图。
    const unsaved = getSession().tabs.filter((t) => hit(t.path) && isUnsaved(t)).length;
    // 删 .java 之前查一下别处有没有引用：没有语言服务也能给出「大概有多少地方提到它」，
    // 让用户在确认框里就能看出这一刀会不会削到别人
    let refs = 0;
    let refSamples: string[] = [];
    if (!target.isDir) {
      try {
        const r = await checkReferences(target.path);
        refs = r.count;
        refSamples = r.samples;
      } catch {
        // 查不到就当没有引用：这是提示，不该因为它让删除按钮点不动
      }
    }
    setPendingDelete({ ...target, files, labels, unsaved, refs, refSamples });
  };

  /** 删掉目录后，缓存里以它为前缀的键都失效了。 */
  const dropTree = (path: string) =>
    setTree((t) => {
      const lower = path.toLowerCase();
      const keep = (p: string) => {
        const pl = p.toLowerCase();
        return !(pl === lower || pl.startsWith(`${lower}\\`));
      };
      const nextDirs: Record<string, TreeDirState> = {};
      for (const [k, v] of Object.entries(t.dirs)) if (keep(k)) nextDirs[k] = v;
      const nextMarks: Record<string, EncodingMark> = {};
      for (const [k, v] of Object.entries(t.marks)) if (keep(k)) nextMarks[k] = v;
      return {
        ...t,
        dirs: nextDirs,
        marks: nextMarks,
        expanded: new Set([...t.expanded].filter(keep)),
      };
    });

  const confirmDelete = async () => {
    const d = pendingDelete;
    if (!d) return;
    setPendingDelete(null);
    try {
      await deleteEntry(d.path, d.isDir);
      if (d.isDir) dropTree(d.path);
      onDeleted([d.path]);
      setSelected(null);
      await load(dirName(d.path));
      toast(`已删除 ${baseName(d.path)}`, "success");
    } catch (e) {
      toast(failureText("删除", e), "error");
    }
  };

  return { pendingDelete, askDelete, confirmDelete, cancelDelete: () => setPendingDelete(null) };
}
