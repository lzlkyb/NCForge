import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { TabMeta } from "../../lib/workspaceSession";

/**
 * 编辑器上方的标签条 + 编译按钮。
 *
 * 中键关闭（`onAuxClick`）：Eclipse / VS Code / 浏览器都是这个习惯，
 * 关一个看完的标签不该必须把鼠标移到右边的小叉上。
 */
export function TabStrip({
  tabs,
  activePath,
  compiling,
  canCompile,
  onSelect,
  onClose,
  onCompile,
}: {
  tabs: TabMeta[];
  activePath: string | null;
  compiling: boolean;
  canCompile: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCompile: () => void;
}) {
  return (
    <div className="wb-tabs" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.path}
          role="tab"
          aria-selected={t.path === activePath}
          className="wb-tab"
          data-active={t.path === activePath || undefined}
          title={t.path}
          onClick={() => onSelect(t.path)}
          onAuxClick={(e) => e.button === 1 && onClose(t.path)}
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
      <span className="wb-tabs-sp" />
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
    </div>
  );
}
