import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { baseName } from "../../lib/workspace";

/**
 * 左栏顶部：资源管理器标题 + 三个动作（新建文件 / 新建文件夹 / 换目录）。
 *
 * 换目录用就地展开的输入框而不是弹窗：换目录要能看到当前路径做参照，
 * 弹窗遮住树反而不方便核对。
 */
export function TreeHeader({
  root,
  editing,
  draft,
  unsaved,
  onDraftChange,
  onOpen,
  onToggleEditing,
  onCreateFile,
  onCreateDir,
}: {
  root: string;
  editing: boolean;
  draft: string;
  unsaved: boolean;
  onDraftChange: (value: string) => void;
  onOpen: () => void;
  onToggleEditing: () => void;
  onCreateFile: () => void;
  onCreateDir: () => void;
}) {
  const ready = draft.trim().length > 0;
  return (
    <>
      <div className="wb-pane-title">
        <span title={root}>资源管理器 · {baseName(root).toUpperCase()}</span>
        <div className="wb-pane-acts">
          <button
            type="button"
            className="wb-icon-btn"
            title="新建文件（在当前选中的目录下）"
            aria-label="新建文件"
            onClick={onCreateFile}
          >
            <Icon name="filePlus" size={14} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title="新建文件夹（在当前选中的目录下）"
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
      {editing && (
        <div className="wb-root-edit">
          <Input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ready && onOpen()}
            autoFocus
          />
          <Button size="sm" disabled={!ready} onClick={onOpen}>
            打开
          </Button>
        </div>
      )}
      {editing && unsaved && (
        <div className="wb-row-note" data-tone="bad">
          有未保存的修改，换目录会丢弃它们
        </div>
      )}
    </>
  );
}
