import { useState } from "react";
import { useWorkbenchDock } from "./WorkbenchDock";
import { ToolTab } from "./ToolTab";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { relativeTo } from "../../lib/compile";
import type { TabMeta } from "../../lib/workspaceSession";

/**
 * 编辑器上方的标签条 + 编译按钮。
 *
 * 中键关闭（`onAuxClick`）：Eclipse / VS Code / 浏览器都是这个习惯，
 * 关一个看完的标签不该必须把鼠标移到右边的小叉上。
 * 预览标签（斜体）双击固定；右键有「关闭其他 / 右侧 / 已保存」和复制路径。
 */
export function TabStrip({
  root,
  tabs,
  activePath,
  compiling,
  canCompile,
  onSelect,
  onClose,
  onCloseMany,
  onPin,
  onCompile,
}: {
  root: string;
  tabs: TabMeta[];
  activePath: string | null;
  compiling: boolean;
  canCompile: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** 批量关闭：未保存的保留，返回保留个数。 */
  onCloseMany: (want: (t: TabMeta, index: number) => boolean) => number;
  onPin: (path: string) => void;
  onCompile: () => void;
}) {
  const dock = useWorkbenchDock();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const closeMany = (want: (t: TabMeta, index: number) => boolean) => {
    const kept = onCloseMany(want);
    if (kept > 0) toast(`${kept} 个有未保存修改的标签已保留`, "info");
  };
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast("已复制", "success"))
      .catch(() => toast("复制失败", "error"));
  };
  const menuItems = (path: string): ContextMenuItem[] => {
    const i = tabs.findIndex((t) => t.path === path);
    const t = tabs[i];
    return [
      { label: "关闭", onSelect: () => onClose(path) },
      { label: "关闭其他", disabled: tabs.length < 2, onSelect: () => closeMany((x) => x.path !== path) },
      { label: "关闭右侧", disabled: i === tabs.length - 1, onSelect: () => closeMany((_, j) => j > i) },
      { label: "关闭已保存的", onSelect: () => closeMany(() => true) },
      { label: "固定标签", separator: true, disabled: !t?.preview, onSelect: () => onPin(path) },
      { label: "复制路径", separator: true, disabled: !!t?.virtual, onSelect: () => copy(path) },
      { label: "复制相对路径", disabled: !!t?.virtual, onSelect: () => copy(relativeTo(root, path)) },
    ];
  };

  return (
    <div className="wb-tabs" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.path}
          role="tab"
          aria-selected={!dock?.documentOpen && t.path === activePath}
          className="wb-tab"
          data-active={(!dock?.documentOpen && t.path === activePath) || undefined}
          data-preview={t.preview || undefined}
          title={t.preview ? `${t.path}\n（预览标签，双击或开始编辑后固定）` : t.path}
          tabIndex={0}
          onKeyDown={e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(t.path); dock?.showCode(); } }}
          onClick={() => { onSelect(t.path); dock?.showCode(); }}
          onDoubleClick={() => onPin(t.path)}
          onAuxClick={(e) => e.button === 1 && onClose(t.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, path: t.path });
          }}
        >
          <span className="wb-tab-name">{t.name}</span>
          {t.readOnly && <span className="wb-status-warn">只读</span>}
          <button
            type="button"
            className="wb-tab-x"
            aria-label={`关闭 ${t.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.path);
            }}
          >
            {t.dirty || t.eolChanged ? <span className="wb-dirty-dot" /> : <Icon name="close" size={12} />}
          </button>
        </div>
      ))}
      <ToolTab />
      <span className="wb-tabs-sp" />
      {!dock?.documentOpen && (
        <Button
          size="sm"
          variant="outline"
          className="wb-compile-btn"
          disabled={!canCompile || compiling}
          title="用 ecj 编译当前文件所在模块，产物写到该模块的 classes 目录"
          onClick={onCompile}
        >
          <Icon name="play" size={12} />
          {compiling ? "编译中…" : "编译"}
        </Button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.path)} onClose={() => setMenu(null)} />}
    </div>
  );
}
