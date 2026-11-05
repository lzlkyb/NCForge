import { useRef, useState } from "react";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { baseName } from "../../lib/workspace";
import { useOperations } from "../../lib/operations";
import { setPackageView, usePackageView } from "../../lib/treeViewPrefs";
import { TreeViewOptions } from "./TreeViewOptions";

/**
 * 左栏顶部：资源管理器标题 + 三个动作（新建文件 / 新建文件夹 / 换目录）。
 *
 * 换目录走系统文件夹选择器：手打路径的斜杠方向、大小写、目录不存在都会失败，
 * 而选择器至少保证选中的是一个真实存在的文件夹。最近工作区仍保留一键切换。
 */
export function TreeHeader({
  root,
  projectCount = 1,
  recents,
  onOpen,
  onOpenRecent,
  onCreateFile,
  onCreateDir,
  onSearch,
}: {
  root: string;
  /** 关联工程数（含当前）。>1 时在标题下说清「编译 / SVN 只作用于当前」 */
  projectCount?: number;
  /** 最近工作区（换目录时直接点，不用再走选择器）。 */
  recents: string[];
  onOpen: (path: string) => void;
  onOpenRecent: (path: string) => void;
  onCreateFile: () => void;
  onCreateDir: () => void;
  /** 切到全工程搜索（侧栏视图，不再占主导航页签）。 */
  onSearch: () => void;
}) {
  const packageView = usePackageView();
  const tasks = useOperations();
  const switching = tasks.some((o) => o.key === "workspace.switch" && !o.endedAt);
  const [error, setError] = useState<string | null>(null);
  const picking = useRef(false);

  const choose = async () => {
    if (picking.current || switching) return;
    picking.current = true;
    setError(null);
    try {
      const path = await pickFolder({ title: "更换工作区目录", defaultPath: root });
      // 取消选择保持原目录，不弹错误。
      if (path) onOpen(path);
    } catch (e) {
      setError(pickFolderError(e));
    } finally {
      picking.current = false;
    }
  };

  return (
    <>
      <div className="wb-pane-title wb-code-tree-title">
        {/* 原样显示目录名：`toUpperCase` 会把 `nc-workbench` 改成另一串字，
            含中文时又只改到其中几个字母，用户核对路径时反而找不到对应目录。 */}
        <div className="wb-code-tree-heading">
          <span title={root}>{packageView ? "包资源管理器" : "资源管理器"}</span>
          <div className="wb-tree-view-switch" role="group" aria-label="资源树视图">
            <button type="button" aria-label="文件视图" aria-pressed={!packageView} onClick={() => setPackageView(false)}>文件</button>
            <button type="button" aria-label="包视图" aria-pressed={packageView} onClick={() => setPackageView(true)}>包</button>
          </div>
        </div>
        <div className="wb-pane-acts">
          <TreeViewOptions root={root} />
          <button
            type="button"
            className="wb-icon-btn"
            title="全工程搜索（Ctrl+K）"
            aria-label="全工程搜索"
            onClick={onSearch}
          >
            <WorkspaceGlyph name="search" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="新建文件（建在选中的文件夹下；没选中就建在根目录）"
            aria-label="新建文件"
            onClick={onCreateFile}
          >
            <WorkspaceGlyph name="newFile" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="新建文件夹（建在选中的文件夹下；没选中就建在根目录）"
            aria-label="新建文件夹"
            onClick={onCreateDir}
          >
            <WorkspaceGlyph name="newFolder" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="更换工作区目录（系统文件夹选择器）"
            aria-label="更换工作区目录"
            disabled={switching}
            onClick={() => void choose()}
          >
            <WorkspaceGlyph name="openWorkspace" size={14} />
          </button>
        </div>
      </div>
      {projectCount > 1 && (
        <div className="wb-tree-scope">
          当前 <b>{baseName(root) || root}</b> · 编译 / SVN 只作用于它 · 共 {projectCount} 个关联工程
        </div>
      )}
      {error && (
        <div className="wb-row-note" data-tone="bad" role="alert">
          {error}
        </div>
      )}
      {recents.length > 0 && (
        <div className="wb-root-recent">
          <span className="wb-root-recent-label">最近</span>
          {recents.map((p) => (
            <button key={p} type="button" className="wb-root-recent-item" title={p} disabled={switching}
              onClick={() => onOpenRecent(p)}>
              {baseName(p)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
