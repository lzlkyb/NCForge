import type { ComponentProps } from "react";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { Breadcrumb } from "./Breadcrumb";
import { ChangedLinesBar } from "./ChangedLinesBar";
import { NavigationHistoryMenu } from "./NavigationHistoryMenu";
import type { TabMeta } from "../../lib/workspaceSession";
import "../../reading-tools.css";

export type EditorNavigation = ComponentProps<typeof EditorNavRow>;

/** 路径行只留导航与改动摘要；阅读选项归布局，结构快跳归顶部符号。 */
export function EditorNavRow({ active, root, canBack, canForward, onBack, onForward, onJumpHistory }: {
  active: TabMeta; root: string; canBack: boolean; canForward: boolean;
  onBack: () => void; onForward: () => void; onJumpHistory: (index: number) => void;
  outlineOpen: boolean;
}) {
  return <div className="wb-crumb-row" role="group" aria-label="文件路径与阅读工具">
    <button type="button" className="wb-nav-btn" disabled={!canBack} title="后退（回到上一个跳转位置）" aria-label="后退" onClick={onBack}><WorkspaceGlyph name="back" size={16} /></button>
    <button type="button" className="wb-nav-btn" disabled={!canForward} title="前进" aria-label="前进" onClick={onForward}><WorkspaceGlyph name="forward" size={16} /></button>
    <NavigationHistoryMenu root={root} onSelect={onJumpHistory} />
    <Breadcrumb root={root} active={active} />
    <ChangedLinesBar compact path={active.virtual ? null : active.path} />
  </div>;
}
