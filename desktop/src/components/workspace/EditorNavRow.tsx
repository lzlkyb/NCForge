import { Icon } from "../ui/icon";
import { Breadcrumb } from "./Breadcrumb";
import { HistoryPanel } from "./HistoryPanel";
import { OutlinePanel } from "./OutlinePanel";
import type { TabMeta } from "../../lib/workspaceSession";

/** 「本地历史」弹层的开关与回调。打包成一个 prop：平铺会把参数列表撑到 16 个。 */
export interface HistorySlot {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** 文件有未保存修改：禁用恢复 */
  dirty: boolean;
  /** 恢复成功后父组件重载文件 */
  onRestored: (path: string) => void;
}

/**
 * 编辑器上方那一行：后退 / 前进 + 面包屑 + 「结构」「历史」按钮 + 两个弹层。
 *
 * 从 `FilesTab` 抽出来（它已经顶到组件体量门禁：≤300 行、≤8 个 useState/useEffect）。
 * 本组件无自己的状态，全部经 props 进出——导航栈在 `lib/navHistory`，弹层开关在父组件。
 */
export function EditorNavRow({
  active,
  root,
  canBack,
  canForward,
  onBack,
  onForward,
  outlineOpen,
  onToggleOutline,
  onCloseOutline,
  onJump,
  history,
}: {
  active: TabMeta;
  root: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  onJump: (line: number) => void;
  history: HistorySlot;
}) {
  return (
    <div className="wb-crumb-row">
      {/* 后退 / 前进：找引用、跳实现之后一定要有，否则只能靠自己记「刚才在哪儿」 */}
      <button
        type="button"
        className="wb-nav-btn"
        disabled={!canBack}
        title="后退（回到上一个跳转位置）"
        aria-label="后退"
        onClick={onBack}
      >
        <Icon name="arrowLeft" size={13} />
      </button>
      <button
        type="button"
        className="wb-nav-btn"
        disabled={!canForward}
        title="前进"
        aria-label="前进"
        onClick={onForward}
      >
        <Icon name="arrowRight" size={13} />
      </button>
      <Breadcrumb root={root} active={active} />
      {!active.virtual && (
        <>
          <button
            type="button"
            className="wb-outline-btn"
            data-popover="outline"
            data-active={outlineOpen || undefined}
            aria-expanded={outlineOpen}
            title="文件结构（本文件的类 / 方法 / 字段）"
            onClick={onToggleOutline}
          >
            <Icon name="code" size={13} />
            <span>结构</span>
          </button>
          <button
            type="button"
            className="wb-outline-btn"
            data-active={history.open || undefined}
            data-popover="history"
            aria-expanded={history.open}
            title="本地历史（自动归档的旧版本，可恢复）"
            onClick={history.onToggle}
          >
            <Icon name="clock" size={13} />
            <span>历史</span>
          </button>
        </>
      )}
      <OutlinePanel
        open={outlineOpen && !active.virtual}
        onClose={onCloseOutline}
        path={active.path}
        mtimeMs={active.mtimeMs}
        onJump={onJump}
      />
      <HistoryPanel
        open={history.open && !active.virtual}
        onClose={history.onClose}
        path={active.path}
        dirty={history.dirty}
        onRestored={history.onRestored}
      />
    </div>
  );
}
