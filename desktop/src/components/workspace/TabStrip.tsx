import { CodeSvnBadge } from "./CodeSvnBadge";
import { TreeSvnContext } from "./TreeSvnContext";
import { pathKey } from "../../lib/treeSvn";
import { svnStatusLabel } from "../../lib/svn";
import { openSvnChange } from "../../lib/svnSession";
import { EditorTabTypeIcon } from "./EditorTabTypeIcon";
import { ProblemBadge, problemDescription } from "./ProblemBadge";
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useWorkbenchDock } from "./WorkbenchDock";
import { ContextMenu } from "./ContextMenu";
import { tabMenuItems } from "./tabMenu";
import { AllEditorTabs } from "./AllEditorTabs";
import { TaskMenu } from "./TaskMenu";
import { Button } from "../ui/button";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { Icon } from "../ui/icon";
import { WorkspaceFileName } from "./WorkspaceFileName";
import { toast } from "../ui/toast";
import { tabPathLabels } from "../../lib/tabPathLabels";
import { setSession } from "../../lib/workspaceSession";
import { useProblemMarks } from "../../hooks/useProblemMarks";
import { diagnosticPathKey } from "../../lib/diagnosticScope";
import type { TabMeta } from "../../lib/workspaceSession";
import { emptyEditorGroups, type EditorGroupId } from "../../lib/editorGroups";
import { initReviewMarks, isReviewed, reviewMarksVersion, subscribeReviewMarks } from "../../lib/reviewMarks";

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
  splitPath,
  compiling,
  canCompile,
  onSelect,
  onClose,
  onCloseMany,
  onPin,
  onOpenSplit,
  onCloseSplit,
  onCompile,
  groupId,
  compactTools = false,
  onMoveGroup,
  tools,
}: {
  root: string;
  tabs: TabMeta[];
  activePath: string | null;
  /** 右侧分屏里显示的文件（没有分屏为 null）。 */
  splitPath: string | null;
  compiling: boolean;
  canCompile: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** 批量关闭：未保存的保留，返回保留个数。 */
  onCloseMany: (want: (t: TabMeta, index: number) => boolean) => number;
  onPin: (path: string) => void;
  onOpenSplit: (path: string) => void;
  onCloseSplit: () => void;
  onCompile: () => void;
  groupId?: EditorGroupId;
  compactTools?: boolean;
  onMoveGroup?: (path: string) => void;
  /** 由外壳并入这一行的执行/分组工具，省掉主区顶部再叠一条 36px 工具条。 */
  tools?: ReactNode;
}) {
  const dock = useWorkbenchDock();
  // 已审角标跟版本控制面同一份后端标记；订阅只为了在失效时重渲染这一条标签条。
  initReviewMarks();
  useSyncExternalStore(subscribeReviewMarks, reviewMarksVersion, reviewMarksVersion);
  const svnFiles = useContext(TreeSvnContext).files;
  const pathLabels = tabPathLabels(root, tabs);
  const { paths: marks } = useProblemMarks();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  /** 正在被拖的标签路径（HTML5 拖放只在 start 时给，dragover 时读不到）。 */
  const dragFrom = useRef<string | null>(null);
  /** 漫游 tabIndex：整组标签只占一个 Tab 停靠点，组内用方向键移动（WAI-ARIA tabs 模式）。 */
  const activeIndex = tabs.findIndex((t) => t.path === activePath);
  const rovingIndex = !dock?.documentOpen && activeIndex >= 0 ? activeIndex : 0;

  // 开得太多时当前标签可能滚到看不见：切换后把它带回可视区，只动标签条自己的 scrollLeft。
  useEffect(() => {
    const el = activePath ? tabRefs.current.get(activePath) : null;
    const strip = el?.parentElement;
    if (!el || !strip) return;
    // offsetLeft 相对最近的定位祖先（`.wb-editor-groups`），而 scrollLeft 相对滚动容器：
    // 分屏时两者差了一个左组的宽度，直接用会把标签滚过头。减去容器自身的 offsetLeft 归一。
    const left = el.offsetLeft - strip.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 8);
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
  }, [activePath, tabs.length]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>, i: number, path: string) => {
    if(e.target!==e.currentTarget || e.nativeEvent.isComposing) return;
    const last = tabs.length - 1;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(path);
      dock?.showCode();
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      // 这一格马上会被卸载，焦点直接掉到 body，整条标签条就再也用不了方向键。
      // 先记下邻居，关完在下一帧把它接住（tabs 要等这一轮渲染后才更新）。
      const sibling = tabs[i + 1]?.path ?? tabs[i - 1]?.path;
      onClose(path);
      if (sibling) requestAnimationFrame(() => tabRefs.current.get(sibling)?.focus());
      return;
    }
    let next = -1;
    if (e.key === "ArrowRight") next = i >= last ? 0 : i + 1;
    else if (e.key === "ArrowLeft") next = i <= 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next < 0) return;
    e.preventDefault();
    const target = tabs[next];
    onSelect(target.path);
    dock?.showCode();
    tabRefs.current.get(target.path)?.focus();
  };

  const closeMany = (want: (t: TabMeta, index: number) => boolean) => {
    const kept = onCloseMany(want);
    if (kept > 0) toast(`${kept} 个有未保存修改的标签已保留`, "info");
  };

  /** 拖拽排序的落点：把被拖的标签插到目标标签**前面**（与 IDEA / 浏览器一致）。 */
  const moveTab = (target: string) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (!from || from === target) return;
    if (groupId) {
      setSession({ editorGroups: old => {
        const groups = old ?? emptyEditorGroups(), next = groups[groupId].slice();
        const i = next.indexOf(from), j = next.indexOf(target); if (i < 0 || j < 0) return groups;
        next.splice(i, 1); next.splice(next.indexOf(target), 0, from); return { ...groups, [groupId]: next };
      } }); return;
    }
    setSession({
      tabs: (prev) => {
        const i = prev.findIndex((t) => t.path === from);
        const j = prev.findIndex((t) => t.path === target);
        if (i < 0 || j < 0) return prev;
        const next = prev.slice();
        const [moved] = next.splice(i, 1);
        next.splice(next.findIndex(tab => tab.path === target), 0, moved);
        return next;
      },
    });
  };
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast("已复制", "success"))
      .catch(() => toast("复制失败", "error"));
  };
  const menuItems = (path: string) => tabMenuItems({
    root, tabs, splitPath, groupId, onMoveGroup, onClose,
    onCloseMany: closeMany, onOpenSplit, onCloseSplit, copy, svnFiles,
  }, path);

  return (
    <div className="wb-tabs" role="tablist" aria-label={groupId ? `${groupId === 'left' ? '左' : '右'}编辑器组文件` : '打开的文件'}>
      <div className="wb-tabs-scroll">
      {tabs.map((t, i) => {
        const svn = t.virtual ? undefined : svnFiles.get(pathKey(t.path));
        const problem = marks.get(diagnosticPathKey(t.path));
        return (
        <div
          key={t.path}
          ref={(node) => {
            if (node) tabRefs.current.set(t.path, node);
            else tabRefs.current.delete(t.path);
          }}
          role="tab"
          aria-selected={!dock?.documentOpen && t.path === activePath}
          aria-controls={groupId ? `wb-editor-${groupId}-surface` : "wb-code-surface"}
          aria-label={[t.name, pathLabels.get(t.path), svn && svnStatusLabel[svn]].filter(Boolean).join(" · ")}
          aria-description={[t.readOnly && "只读", problemDescription(problem)].filter(Boolean).join(" · ") || undefined}
          className="wb-tab"
          data-active={(!dock?.documentOpen && t.path === activePath) || undefined}
          data-preview={t.preview || undefined}
          data-pinned={t.pinned || undefined}
          title={t.preview ? `${t.path}\n（预览标签，双击或开始编辑后固定）` : t.path}
          tabIndex={i === rovingIndex ? 0 : -1}
          draggable
          onDragStart={(e) => {
            dragFrom.current = t.path;
            e.dataTransfer.effectAllowed = "move";
            // 某些 WebView 里不设数据的话拖拽不会启动
            e.dataTransfer.setData("text/plain", t.path);
          }}
          onDragOver={(e) => {
            if (!dragFrom.current || dragFrom.current === t.path) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            moveTab(t.path);
          }}
          onDragEnd={() => {
            dragFrom.current = null;
          }}
          onKeyDown={e => onTabKey(e, i, t.path)}
          onClick={() => { onSelect(t.path); dock?.showCode(); }}
          onDoubleClick={() => onPin(t.path)}
          // 中键两处都要拦：`auxclick` 拦的是关闭，`mousedown` 拦的是 WebView2 的
          // 中键自动滚动——不拦住的话关标签的同时还会把页面切成滚动状态。
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.path); } }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, path: t.path });
          }}
        >
          <EditorTabTypeIcon path={t.path} name={t.name} mtimeMs={t.mtimeMs} />
          {t.pinned && <span className="wb-tab-pinned" title="已钉住"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 3H8l1 6-4 4v3h14v-3l-4-4 1-6Z M12 16v6" /></svg></span>}
          <WorkspaceFileName name={t.name} className="wb-tab-name" />
          {pathLabels.has(t.path) && <span className="wb-tab-scope">· {pathLabels.get(t.path)}</span>}
          <ProblemBadge mark={problem} path={t.path} name={t.name} tabStop={i === rovingIndex} />
          {svn && <CodeSvnBadge status={svn} tabIndex={i === rovingIndex ? 0 : -1} onOpen={() => openSvnChange(t.path, svn === "C" ? "conflict" : "review")} />}
          {isReviewed(t.path) && <span className="ncf-reviewed" title="已审 · 文件再被改动会自动失效">已审</span>}
          {t.readOnly && <span className="wb-status-warn">只读</span>}
          <button
            type="button"
            className="wb-tab-x"
            tabIndex={i === rovingIndex ? 0 : -1}
            aria-label={`关闭 ${t.name}`}
            title={t.dirty || t.eolChanged ? "关闭（有未保存修改，会先确认）" : `关闭 ${t.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.path);
            }}
          >
            {t.dirty || t.eolChanged ? (
              <>
                <span className="wb-dirty-dot" />
                <WorkspaceGlyph name="close" size={12} className="wb-tab-close" />
              </>
            ) : (
              <WorkspaceGlyph name="close" size={12} />
            )}
          </button>
        </div>
        );
      })}
      </div>
      {/* 标签太多时横向滚动条不好找：给一个「所有标签」下拉，键盘用户也能到这里 */}
      <AllEditorTabs root={root} tabs={tabs} activePath={activePath} onSelect={path => { onSelect(path); dock?.showCode(); }} />
      {/* 执行/分组工具与文件标签同一行：600px 高窗口净增约 36px 正文 */}
      {tools && <span className="wb-tabs-tools">{tools}</span>}
      {!compactTools && !dock?.documentOpen && <TaskMenu root={root} compiling={compiling} />}
      {!compactTools && !dock?.documentOpen && (
        <Button
          size="sm"
          variant="outline"
          className="wb-compile-btn"
          disabled={!canCompile || compiling}
          isLoading={compiling} loadingText="编译中"
          title="用 ecj 编译当前文件所在模块，产物写到该模块的 classes 目录"
          onClick={onCompile}
        >
          <Icon name="hammer" size={16} />
          {compiling ? "编译中…" : "编译"}
        </Button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.path)} onClose={() => setMenu(null)} />}
    </div>
  );
}
