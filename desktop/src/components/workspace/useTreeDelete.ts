import { useRef, useState } from "react";
import { baseName, countFiles, deleteEntry, dirName } from "../../lib/workspace";
import { toast } from "../ui/toast";
import { setTree, type TreeDirState } from "../../lib/workspaceSession";
import type { EncodingMark } from "../../lib/workspace";

/** 待确认的删除（目录要先数一下里面有多少文件，所以确认框是异步准备的）。 */
export interface PendingDelete {
  path: string;
  isDir: boolean;
  files: number;
  labels: number;
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
        toast(`读取文件数失败：${e}`, "error");
        return;
      }
    }
    const lower = target.path.toLowerCase();
    const labels = openPathsRef.current.filter((p) => {
      const pl = p.toLowerCase();
      return pl === lower || pl.startsWith(`${lower}\\`);
    }).length;
    setPendingDelete({ ...target, files, labels });
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
      toast(`删除失败：${e}`, "error");
    }
  };

  return { pendingDelete, askDelete, confirmDelete, cancelDelete: () => setPendingDelete(null) };
}
