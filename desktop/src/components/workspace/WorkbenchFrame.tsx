import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WorkbenchDockContext, type DockRegionName, type DockToolTab } from "./WorkbenchDock";
import { ToolTab } from "./ToolTab";
import { useSideOpen } from "../../lib/layoutStore";

/** 这些工具把自己的操作条停靠进顶部工具条；其余工具不占这一行。 */
const TOOLBAR_TOOLS = ["svn", "patch", "services"];
/** 这些工具的入口放在共享侧栏；其余工具侧栏仍是文件树。 */
const SIDE_TOOLS = ["search", "svn", "patch", "db", "settings"];
/** 这些工具有文档页，因此标签条里多一个工具标签。 */
const DOCUMENT_TOOLS: Record<string, DockToolTab> = {
  svn: { label: "版本控制 · 差异", icon: "gitBranch" },
  patch: { label: "补丁", icon: "package" },
  db: { label: "数据库", icon: "database", custom: true },
  settings: { label: "设置", icon: "settings" },
};
/**
 * 切到该工具时默认打开文档页。
 *
 * svn 有意不在列表里：打开版本控制先看源码，点「版本控制 · 差异」才切到差异，
 * 和用户从文件树点进来继续改代码的动线一致。少写这一句就会被当成漏配。
 */
const DOCUMENT_DEFAULT_OPEN = ["patch", "db", "settings"];
/** NC 服务的卡片 + 日志放在底部面板里，切过去时把面板撑高到够看。 */
const SERVICES_PANEL_MIN = 360;
const HOST_NAMES: DockRegionName[] = ["toolbar", "sidebar", "document", "bottom", "actions", "tabs"];

export function WorkbenchFrame({ activeTool, tool, tree, tabs, editor, output, status }: {
  activeTool: string; tool?: ReactNode; tree: ReactNode; tabs: ReactNode;
  editor: ReactNode; output: ReactNode; status: ReactNode;
}) {
  const [hosts, setHosts] = useState<Record<DockRegionName, HTMLElement | null>>({ toolbar: null, sidebar: null, document: null, bottom: null, actions: null, tabs: null });
  const [documentOpen, setDocumentOpen] = useState(false);
  const sideOpen = useSideOpen();
  const [sideWidth, setSideWidth] = useState(240);
  const [bottomHeight, setBottomHeight] = useState(240);
  // 每个宿主一个稳定的 ref 回调：回调身份变了 React 会先 null 再重填，宿主里的工具内容就闪一下
  const refs = useMemo(() => Object.fromEntries(HOST_NAMES.map(name => [name, (node: HTMLElement | null) => setHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<DockRegionName, (node: HTMLElement | null) => void>, []);
  useEffect(() => {
    setDocumentOpen(DOCUMENT_DEFAULT_OPEN.includes(activeTool));
    if (activeTool === "services") setBottomHeight(h => Math.max(h, SERVICES_PANEL_MIN));
  }, [activeTool]);
  const showCode = useCallback(() => setDocumentOpen(false), []);
  const showDocument = useCallback(() => setDocumentOpen(true), []);
  const toolTab = DOCUMENT_TOOLS[activeTool] ?? null;
  const dock = useMemo(() => ({ hosts, bindHost: (name: DockRegionName) => refs[name], showDocument, showCode, documentOpen, toolTab }), [hosts, refs, showDocument, showCode, documentOpen, toolTab]);
  const hasSide = SIDE_TOOLS.includes(activeTool);
  const hasToolbar = TOOLBAR_TOOLS.includes(activeTool);
  // 设置是整页表单，不需要问题 / 构建面板；其它文档页（补丁、数据库）打开时同样让位；NC 服务的内容就在面板里。
  const showPanel = Boolean(output) && activeTool !== "settings" && (!documentOpen || activeTool === "services");
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const resize = (axis: "side" | "bottom", start: number, value: number) => {
    resizeCleanup.current?.();
    const move = (e: PointerEvent) => axis === "side"
      ? setSideWidth(Math.max(180, Math.min(420, value + e.clientX - start)))
      : setBottomHeight(Math.max(140, Math.min(window.innerHeight * .65, value + start - e.clientY)));
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); resizeCleanup.current = null; };
    resizeCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("pointerup", finish, { once: true });
  };
  return <WorkbenchDockContext.Provider value={dock}>
    <div className="wb-root" data-tool={activeTool}>
      <header className="wb-toolbar" hidden={!hasToolbar}>
        <div ref={refs.toolbar} className="wb-toolbar-host" />
        <div ref={refs.actions} className="wb-toolbar-actions" />
      </header>
      <div className="wb-layout" data-side-open={sideOpen} style={{ gridTemplateColumns: sideOpen ? `${sideWidth}px 4px minmax(0,1fr)` : "0px 0px minmax(0,1fr)" }}>
        {/* 收起时不能用 hidden：display:none 的 aside 不占网格格子，后面的分隔条与主区会各前进一格，主区落进 0px 那一列 */}
        <aside className="wb-tree" data-closed={!sideOpen || undefined}>
          <div className="wb-tree-native" hidden={hasSide}>{tree}</div>
          <div ref={refs.sidebar} className="wb-sidebar-host" hidden={!hasSide} />
        </aside>
        <div className="wb-resize-x" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={e => { e.preventDefault(); resize("side", e.clientX, sideWidth); }} onKeyDown={e => { if(e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSideWidth(w => Math.max(180, Math.min(420, w + (e.key === "ArrowRight" ? 10 : -10)))); } }} />
        <section className="wb-main">
          <div className="wb-tabbar">{tabs ?? <div className="wb-tabs" role="tablist"><ToolTab /></div>}</div>
          <div className="wb-code-surface" hidden={documentOpen}>{editor}</div>
          <div ref={refs.document} className="wb-document-surface" hidden={!documentOpen} />
          {showPanel && <>
            <div className="wb-resize-y" role="separator" aria-label="调整底部面板高度" aria-orientation="horizontal" tabIndex={0} onPointerDown={e => { e.preventDefault(); resize("bottom", e.clientY, bottomHeight); }} onKeyDown={e => { if(e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setBottomHeight(h => Math.max(140, Math.min(window.innerHeight * .65, h + (e.key === "ArrowUp" ? 10 : -10)))); } }} />
            <div className="wb-bottom" style={{ height: bottomHeight }}>{output}</div>
          </>}
        </section>
      </div>
      {status}
      <div className="wb-tool-runtime">{tool}</div>
    </div>
  </WorkbenchDockContext.Provider>;
}
