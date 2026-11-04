import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { baseName } from "../../lib/workspace";
import { useOperations } from "../../lib/operations";
import { TreeViewOptions } from "./TreeViewOptions";

/**
 * 左栏顶部：资源管理器标题 + 三个动作（新建文件 / 新建文件夹 / 换目录）。
 *
 * 换目录用就地展开的输入框而不是弹窗：换目录要能看到当前路径做参照，
 * 弹窗遮住树反而不方便核对。
 */
export function TreeHeader({
  root,
  projectCount = 1,
  editing,
  draft,
  unsaved,
  recents,
  onDraftChange,
  onOpen,
  onOpenRecent,
  onToggleEditing,
  onCreateFile,
  onCreateDir,
  onSearch,
}: {
  root: string;
  /** 关联工程数（含当前）。>1 时在标题下说清「编译 / SVN 只作用于当前」 */
  projectCount?: number;
  editing: boolean;
  draft: string;
  unsaved: boolean;
  /** 最近工作区（换目录时直接点，不用重新输路径）。 */
  recents: string[];
  onDraftChange: (value: string) => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onToggleEditing: () => void;
  onCreateFile: () => void;
  onCreateDir: () => void;
  /** 切到全工程搜索（侧栏视图，不再占主导航页签）。 */
  onSearch: () => void;
}) {
  const tasks=useOperations();
  const switching=tasks.some(o=>o.key==="workspace.switch" && !o.endedAt);
  const ready = draft.trim().length > 0 && !switching;
  return (
    <>
      <div className="wb-pane-title">
        {/* 原样显示目录名：`toUpperCase` 会把 `nc-workbench` 改成另一串字，
            含中文时又只改到其中几个字母，用户核对路径时反而找不到对应目录。 */}
        <span title={root}>资源管理器 · {baseName(root) || root}</span>
        <div className="wb-pane-acts">
          <TreeViewOptions root={root} />
          <button
            type="button"
            className="wb-icon-btn"
            title="全工程搜索（Ctrl+K）"
            aria-label="全工程搜索"
            onClick={onSearch}
          >
            <Icon name="search" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="新建文件（建在选中的文件夹下；没选中就建在根目录）"
            aria-label="新建文件"
            onClick={onCreateFile}
          >
            <Icon name="filePlus" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="新建文件夹（建在选中的文件夹下；没选中就建在根目录）"
            aria-label="新建文件夹"
            onClick={onCreateDir}
          >
            <Icon name="folderPlus" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="更换工作区目录"
            aria-label="更换工作区目录"
            onClick={onToggleEditing}
          >
            <Icon name="folder" size={14} />
          </button>
        </div>
      </div>
      {projectCount > 1 && (
        <div className="wb-tree-scope">
          当前 <b>{baseName(root) || root}</b> · 编译 / SVN 只作用于它 · 共 {projectCount} 个关联工程
        </div>
      )}
      {editing && (
        <div className="wb-root-edit">
          <Input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => !e.nativeEvent.isComposing && e.key === "Enter" && ready && onOpen()}
            autoFocus
          />
          <Button size="sm" disabled={!ready} isLoading={switching} loadingText="切换中" onClick={onOpen}>
            打开
          </Button>
        </div>
      )}
      {editing && unsaved && (
        <div className="wb-row-note" data-tone="bad">
          切换前会提示保存未完成的修改
        </div>
      )}
      {editing && recents.length > 0 && (
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
