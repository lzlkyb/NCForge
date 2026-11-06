import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { Breadcrumb } from "./Breadcrumb";
import { HistoryPanel } from "./HistoryPanel";
import { NavigationHistoryMenu } from "./NavigationHistoryMenu";
import { setEditorPrefs, useEditorPrefs } from "../../lib/editorPrefs";
import type { TabMeta } from "../../lib/workspaceSession";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import "../../reading-tools.css";

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

/** 阅读区工具栏。跳转记录和本地版本历史分别使用各自的数据源。 */
export function EditorNavRow({
  active,
  root,
  canBack,
  canForward,
  onBack,
  onForward,
  onJumpHistory,
  heavy,
  outlineOpen,
  onToggleOutline,
  history,
}: {
  active: TabMeta;
  root: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onJumpHistory: (index: number) => void;
  heavy: boolean;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  history: HistorySlot;
}) {
  const { minimap } = useEditorPrefs();
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
        <WorkspaceGlyph name="back" size={13} />
      </button>
      <button
        type="button"
        className="wb-nav-btn"
        disabled={!canForward}
        title="前进"
        aria-label="前进"
        onClick={onForward}
      >
        <WorkspaceGlyph name="forward" size={13} />
      </button>
      <NavigationHistoryMenu root={root} onSelect={onJumpHistory} />
      <Breadcrumb root={root} active={active} />
      <button type="button" className="wb-outline-btn wb-minimap-toggle wb-reading-secondary" aria-pressed={minimap && !heavy}
        disabled={heavy} title={heavy ? "大文件已暂停小地图" : "显示或隐藏小地图"}
        onClick={() => setEditorPrefs({ minimap: !minimap })}>小地图</button>
      {!active.virtual && (
        <>
          <button
            type="button"
            className="wb-outline-btn wb-reading-outline"
            data-popover="outline"
            data-active={outlineOpen || undefined}
            aria-expanded={outlineOpen}
            title="查看当前文件的声明结构"
            onClick={onToggleOutline}
          >
            <WorkspaceGlyph name="outline" size={13} />
            <span>结构</span>
          </button>
          <button
            type="button"
            className="wb-outline-btn wb-reading-secondary"
            data-active={history.open || undefined}
            data-popover="history"
            aria-expanded={history.open}
            title="本地历史（自动归档的旧版本，可恢复）"
            onClick={history.onToggle}
          >
            <WorkspaceGlyph name="history" size={13} />
            <span>本地历史</span>
          </button>
        </>
      )}
      <div className="wb-crumb-overflow">
        <Menu portal width="w-64" trigger={(open, toggle) => <button type="button" className="wb-icon-btn" aria-label="更多阅读工具" title="结构、小地图与本地历史" aria-expanded={open} aria-haspopup="menu" onClick={toggle}><Icon name="more" size={14} /></button>}>
          {close => <>
            {!active.virtual && <MenuItem label="文件结构" checked={outlineOpen} onClick={() => { close(); onToggleOutline(); }} />}
            <MenuItem label="小地图" checked={minimap && !heavy} disabled={heavy} onClick={() => { close(); setEditorPrefs({ minimap: !minimap }); }} />
            {!active.virtual && <MenuItem label="本地历史" icon="history" onClick={() => { close(); history.onToggle(); }} />}
          </>}
        </Menu>
      </div>
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
