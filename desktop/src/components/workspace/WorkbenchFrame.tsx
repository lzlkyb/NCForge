import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WorkbenchDockContext, type DockRegionName, type DockToolTab, type FileSlotName } from "./WorkbenchDock";
import { ToolTab } from "./ToolTab";
import { ShowDocumentBridge } from "./ShowDocumentBridge";
import { WorkspacePageMotion } from "./WorkspacePageMotion";
import { setSideOpen, useSideOpen } from "../../lib/layoutStore";
import { setSession, useWorkspaceSelector } from "../../lib/workspaceSession";
import { Icon } from "../ui/icon";
import { useWorkbenchGeometry } from "../../hooks/useWorkbenchGeometry";
import { updateWorkbenchLayout } from "../../lib/workbenchLayout";
import { DebugInspectorDock } from "./DebugInspectorDock";
import { useWorkbenchAutoLayout } from "../../hooks/useWorkbenchAutoLayout";
import { PAGES } from "../../lib/pages";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { BP_SM } from "../../lib/layoutBreakpoints";
import { returnFromLogs, takeRestoredTool } from "../../lib/toolReturn";

/** 以下四份清单全部由 `lib/pages.ts` 的单一真源派生，新增页面不再需要改这里。 */
const TOOLBAR_TOOLS = PAGES.filter((p) => p.toolbar).map((p) => p.key);
const SIDE_TOOLS = PAGES.filter((p) => p.sideTool).map((p) => p.key);
const DOCUMENT_TOOLS: Record<string, DockToolTab> = Object.fromEntries(
  PAGES.filter((p) => p.documentDefault).map((p) => [
    p.key,
    { label: p.label, icon: p.icon, ...(p.documentCustom ? { custom: true } : {}) },
  ]),
) as Record<string, DockToolTab>;
const DOCUMENT_DEFAULT_OPEN = PAGES.filter((p) => p.documentDefault).map((p) => p.key);
/** NC 服务的卡片 + 日志放在底部面板里，打开这个标签时把面板撑高到够看。 */
const HOST_NAMES: DockRegionName[] = ["toolbar", "sidebar", "document", "bottom", "actions", "doctabs"];
/** 文件页槽位：由 FilesTab 用 portal 注入（见 WorkbenchDock 的 FileSlotName）。 */
const FILE_SLOTS: FileSlotName[] = ["tree", "context", "tabs", "editor", "status", "output"];

/** 侧栏 / 底部面板的尺寸。拖过就该记住：每次重启都回到 240 是白费用户的调整。 */
const SIDE_MIN = 180;
const SIDE_MAX = 420;
const BOTTOM_MIN = 140;

export function WorkbenchFrame({ activeTool, tool, tree, tabs, editor, output, status }: {
  activeTool: string; tool?: ReactNode;
  tree: ReactNode; tabs: ReactNode;
  editor: ReactNode; output: ReactNode; status: ReactNode;
}) {
  const [hosts, setHosts] = useState<Record<DockRegionName, HTMLElement | null>>({ toolbar: null, sidebar: null, document: null, bottom: null, actions: null, doctabs: null });
  const [fileHosts, setFileHosts] = useState<Record<FileSlotName, HTMLElement | null>>({ tree: null, context: null, tabs: null, editor: null, status: null, output: null });
  /**
   * 用户手动切代码/文档面的显式覆盖。**把归属工具一起存**：`null` = 按 activeTool 派生。
   *
   * 以前只存一个 boolean，切页时靠渲染期间 `if (lastTool.current !== activeTool) setDocOverride(null)`
   * 清掉。那个写法在 View Transition / transition 里 render 被中断时，这次 setState 可能
   * 连同那次 render 一起丢掉，于是 override 残留在新页面：代码页被 `hidden`、文档面又
   * 没有工具可画，主区一片白。绑定工具后不需要再「清」，换了页面它自己就失效。
   */
  const [docOverride, setDocOverride] = useState<{ tool: string; open: boolean } | null>(null);
  const toolRef = useRef(activeTool);
  toolRef.current = activeTool;
  const sideOpen = useSideOpen();
  const pageRef = useRef<HTMLDivElement | null>(null);
  // 控制台正常停靠留足日志正文；展开不改写用户保存的停靠高度。
  const panelOpen = useWorkspaceSelector((s) => s.panelOpen);
  const panelTab = useWorkspaceSelector((s) => s.panelTab);
  const legacyExpanded = useWorkspaceSelector(s => !!s.serviceExpanded);
  const { layout, sideWidth, bottomHeight, bottomMax, resize, onSeparatorKey } = useWorkbenchGeometry(panelTab, activeTool);
  const panelExpanded = activeTool === "files" && panelOpen && (layout.expanded === panelTab || legacyExpanded && panelTab === "svc");
  useWorkbenchAutoLayout(activeTool === "files");
  // 每个宿主一个稳定的 ref 回调：回调身份变了 React 会先 null 再重填，宿主里的工具内容就闪一下
  const refs = useMemo(() => Object.fromEntries(HOST_NAMES.map(name => [name, (node: HTMLElement | null) => setHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<DockRegionName, (node: HTMLElement | null) => void>, []);
  const fileRefs = useMemo(() => Object.fromEntries(FILE_SLOTS.map(name => [name, (node: HTMLElement | null) => setFileHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<FileSlotName, (node: HTMLElement | null) => void>, []);
  /**
   * 当前工具到底有没有「文档面」可显示。
   *
   * 代码页（files）没有：它的内容是代码面里的编辑器。所以 `documentOpen` 必须再与它
   * 求与——否则 `docOverride` 一旦被置 true（状态栏的数据库会话项、命令面板里开补丁
   * 的入口都会经 `showWorkbenchDocument()` 置它），代码面被 `hidden` 藏掉、文档面又
   * 没有任何工具可画，主区就是一片白，而且用户在代码页里没有任何入口能退出来。
   */
  const hasDocumentTool = activeTool in DOCUMENT_TOOLS;
  // 只认当前工具自己的那次覆盖；换了页面旧的自动作废，不依赖渲染期 setState 去清。
  const overrideHere = docOverride !== null && docOverride.tool === activeTool ? docOverride.open : null;
  const documentOpen = (overrideHere ?? DOCUMENT_DEFAULT_OPEN.includes(activeTool)) && hasDocumentTool;
  // 只跟着工具切换重置副作用；底部面板换标签不该把用户刚切回代码的视图顶走。
  const effectTool = useRef(activeTool);
  useEffect(() => {
    if (effectTool.current === activeTool) return;
    effectTool.current = activeTool;
    if (takeRestoredTool(activeTool)) return;
    setSession({ serviceExpanded: false });
    updateWorkbenchLayout({ expanded: null });
  }, [activeTool]);
  const showCode = useCallback(() => setDocOverride({ tool: toolRef.current, open: false }), []);
  const showDocument = useCallback(() => setDocOverride({ tool: toolRef.current, open: true }), []);
  // 必须包 useMemo：`logs` 分支里有内联 onClose，每次渲染都是新对象，
  // 会让下面 `dock` 的 useMemo 依赖整体失效（每次渲染都重建宿主导航绑定）
  const toolTab = useMemo(
    () =>
      activeTool === "logs"
        ? {
            ...DOCUMENT_TOOLS.logs,
            onClose: () => {
              showCode();
              returnFromLogs();
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    '.wb-code-tools [role="tab"][aria-selected="true"], .app-side-item[aria-label="代码"]',
                  )
                  ?.focus(),
              );
            },
          }
        : DOCUMENT_TOOLS[activeTool] ?? null,
    [activeTool, showCode],
  );
  const dock = useMemo(() => ({ hosts, fileHosts, bindHost: (name: DockRegionName) => refs[name], bindFileSlot: (name: FileSlotName) => fileRefs[name], showDocument, showCode, documentOpen, panelExpanded, toolTab }), [hosts, fileHosts, refs, fileRefs, showDocument, showCode, documentOpen, panelExpanded, toolTab]);
  const hasSide = SIDE_TOOLS.includes(activeTool);
  const hasToolbar = TOOLBAR_TOOLS.includes(activeTool);
  // 日志已有列表/详情两栏，不再占用资源树；元数据页自带组件清单，再摆一份文件树
  // 会变成双左栏、把主区挤窄。两页都保留用户在代码页设置的开合偏好。
  const sideShown = sideOpen && activeTool !== "logs" && activeTool !== "meta";
  const sideLabel = activeTool === "settings" ? "设置分类" : "资源侧栏";
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(`(max-width: ${BP_SM}px)`).matches ?? false);
  const sideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.(`(max-width: ${BP_SM}px)`);
    const update = () => setNarrow(media?.matches ?? false);
    media?.addEventListener?.("change", update);
    update();
    return () => media?.removeEventListener?.("change", update);
  }, []);
  const drawerOpen = narrow && sideShown;
  const closeSide = () => {
    setSideOpen(false);
    // 初始打开或焦点触发元素已消失时，关闭抽屉仍需要一个可用的返回入口。
    document.querySelector<HTMLElement>('[aria-label="工作台布局"]')?.focus({ preventScroll: true });
  };
  useFocusTrap(sideRef, { enabled: drawerOpen, onEscape: closeSide });
  // 底部面板有没有内容由 FilesTab 决定（它 portal 到宿主）；这里不再用 `output` 断言，
  // 空面板与分隔条靠 workbench-layout.css 的 `:empty` 规则收起。
  return <WorkbenchDockContext.Provider value={dock}>
    <ShowDocumentBridge show={showDocument} />
    <WorkspacePageMotion page={activeTool} target={pageRef} />
    <div className="wb-root" data-tool={activeTool}>
      <div className="wb-content-frame">
      <header className="wb-toolbar" hidden={!hasToolbar}>
        <div ref={refs.toolbar} className="wb-toolbar-host" />
        <div ref={refs.actions} className="wb-toolbar-actions" />
      </header>
      <div className="wb-layout" data-side-open={sideShown} style={{ gridTemplateColumns: sideShown ? `${sideWidth}px 4px minmax(0,1fr)` : "0px 0px minmax(0,1fr)" }}>
        {/* 收起时不能用 hidden：display:none 的 aside 不占网格格子，后面的分隔条与主区会各前进一格，主区落进 0px 那一列 */}
        <button type="button" className="wb-side-backdrop" aria-label="收起侧栏" tabIndex={-1} hidden={!sideShown} onClick={closeSide} />
        <aside ref={sideRef} className="wb-tree" data-closed={!sideShown || undefined} aria-label={sideLabel} style={narrow ? undefined : { width: sideWidth }}>
          <div className="wb-tree-heading"><span>{sideLabel}</span><button type="button" className="wb-tree-close" aria-label={`关闭${sideLabel}`} onClick={closeSide}><Icon name="close" size={16} /></button></div>
          {/* Keep the retained tree at its own width even while another tool owns this sidebar. */}
          <div ref={fileRefs.tree} className="wb-tree-native" data-inactive={hasSide || !sideShown || undefined} aria-hidden={hasSide || !sideShown || undefined}
            style={narrow ? undefined : { width: layout.sides.files ?? layout.side }}>{tree}</div>
          <div ref={refs.sidebar} className="wb-sidebar-host" hidden={!hasSide} />
        </aside>
        <div className="wb-resize-x" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
          aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX} aria-valuenow={Math.round(sideWidth)}
          aria-hidden={!sideShown || undefined} tabIndex={sideShown ? 0 : -1} onPointerDown={e => {
            if (e.button !== 0 || !e.isPrimary) return;
            e.preventDefault();
            resize("side", e.clientX, sideWidth, { id: e.pointerId, element: e.currentTarget });
          }} onKeyDown={e => onSeparatorKey(e, "side")} />
        <div className="wb-main-with-inspector" ref={node => { pageRef.current = node; if (node) node.inert = drawerOpen; }}>
        <section className="wb-main" data-service-mode={panelOpen && panelTab === "svc" || undefined} data-service-expanded={panelExpanded || undefined} data-panel-expanded={panelExpanded || undefined}>
          {/* 代码面自带文件标签条：切到工具页时整块 hidden，文件标签就不可能和
              文档面的工具标签同屏（以前两者挤在顶层 `wb-tabbar` 的同一条 flex 行里）。
              `hidden` 只由 `documentOpen` 决定：把它和 `panelExpanded` 混在一起会让
              两个面同时 hidden，主区纯白（P1-18）；展开态完全交 CSS 处理。 */}
          <div
            id="wb-code-surface"
            className="wb-code-surface"
            role="tabpanel"
            aria-label="编辑器"
            hidden={documentOpen}
          >
            <div ref={fileRefs.context} className="wb-code-context-host" />
            <div ref={fileRefs.tabs} className="wb-code-tools">{tabs}</div>
            <div ref={fileRefs.editor} className="wb-code-body">{editor}</div>
          </div>
          {/* 文档面同样自带标签条：多文档工具（数据库）停靠进 doctabs，
              单文档工具由 ToolTab 渲染。两个面互斥显示 ⇒ 两套标签永不同屏。 */}
          <div id="wb-document-surface" className="wb-document-surface" role="tabpanel" aria-label={toolTab?.label} hidden={!documentOpen}>
            <div ref={refs.doctabs} className="wb-doc-tabs"><ToolTab /></div>
            <div ref={refs.document} className="wb-doc-body" />
          </div>
          <div hidden={panelExpanded} className="wb-resize-y" role="separator" aria-label="调整底部面板高度" aria-orientation="horizontal"
            aria-valuemin={BOTTOM_MIN} aria-valuemax={bottomMax} aria-valuenow={Math.round(bottomHeight)}
            tabIndex={0} onPointerDown={e => {
              if (e.button !== 0 || !e.isPrimary) return;
              e.preventDefault();
              resize("bottom", e.clientY, bottomHeight, { id: e.pointerId, element: e.currentTarget });
            }} onKeyDown={e => onSeparatorKey(e, "bottom")} />
          <div ref={fileRefs.output} className="wb-bottom" style={{ height: bottomHeight }}>{output}</div>
        </section>
        <DebugInspectorDock />
        </div>
      </div>
      </div>
      <div ref={fileRefs.status} className="wb-status-host">{status}</div>
      <div className="wb-tool-runtime">{tool}</div>
    </div>
  </WorkbenchDockContext.Provider>;
}
