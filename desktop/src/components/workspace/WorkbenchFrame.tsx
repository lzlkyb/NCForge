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
import { useSidebarView } from "../../lib/sidebarView";

/** 这些工具把自己的操作条停靠进顶部工具条；其余工具不占这一行。 */
const TOOLBAR_TOOLS = ["svn"];
/** 这些工具的入口放在共享侧栏；其余工具（含文件页）侧栏仍是文件树。 */
const SIDE_TOOLS = ["svn", "db", "settings"];
/** 这些工具有文档页，因此标签条里多一个工具标签。 */
const DOCUMENT_TOOLS: Record<string, DockToolTab> = {
  // 页内还有「审查改动 / 打包补丁」两个视图，标签只说页名，避免切到补丁时名不副实
  svn: { label: "版本控制", icon: "gitBranch" },
  db: { label: "数据库", icon: "database", custom: true },
  meta: { label: "元数据", icon: "layers" },
  logs: { label: "日志排查", icon: "log" },
  settings: { label: "设置", icon: "settings" },
};
/** 主导航直接显示对应工具；文件模型仍挂载，点源码标签即可继续编辑。 */
const DOCUMENT_DEFAULT_OPEN = ["svn", "db", "meta", "logs", "settings"];
/** NC 服务的卡片 + 日志放在底部面板里，打开这个标签时把面板撑高到够看。 */
const HOST_NAMES: DockRegionName[] = ["toolbar", "sidebar", "document", "bottom", "actions", "doctabs"];
/** 文件页槽位：由 FilesTab 用 portal 注入（见 WorkbenchDock 的 FileSlotName）。 */
const FILE_SLOTS: FileSlotName[] = ["tree", "tabs", "editor", "status", "output"];

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
  const [fileHosts, setFileHosts] = useState<Record<FileSlotName, HTMLElement | null>>({ tree: null, tabs: null, editor: null, status: null, output: null });
  const [documentOpen, setDocumentOpen] = useState(() => DOCUMENT_DEFAULT_OPEN.includes(activeTool));
  const sideOpen = useSideOpen();
  const pageRef = useRef<HTMLDivElement>(null);
  // 控制台正常停靠留足日志正文；展开不改写用户保存的停靠高度。
  const panelOpen = useWorkspaceSelector((s) => s.panelOpen);
  const panelTab = useWorkspaceSelector((s) => s.panelTab);
  const legacyExpanded = useWorkspaceSelector(s => !!s.serviceExpanded);
  const sidebarView = useSidebarView();
  const { layout, sideWidth, bottomHeight, bottomMax, resize, onSeparatorKey } = useWorkbenchGeometry(panelTab, activeTool === "files" && sidebarView === "search" ? "search" : activeTool);
  const panelExpanded = panelOpen && (layout.expanded === panelTab || legacyExpanded && panelTab === "svc");
  useWorkbenchAutoLayout(activeTool === "files");
  // 每个宿主一个稳定的 ref 回调：回调身份变了 React 会先 null 再重填，宿主里的工具内容就闪一下
  const refs = useMemo(() => Object.fromEntries(HOST_NAMES.map(name => [name, (node: HTMLElement | null) => setHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<DockRegionName, (node: HTMLElement | null) => void>, []);
  const fileRefs = useMemo(() => Object.fromEntries(FILE_SLOTS.map(name => [name, (node: HTMLElement | null) => setFileHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<FileSlotName, (node: HTMLElement | null) => void>, []);
  const lastTool = useRef(activeTool);
  useEffect(() => {
    // 只跟着工具切换重置文档视图；底部面板换标签不该把用户刚切回代码的视图顶走
    if (lastTool.current !== activeTool) {
      lastTool.current = activeTool;
      setSession({ serviceExpanded: false });
      updateWorkbenchLayout({ expanded: null });
      setDocumentOpen(DOCUMENT_DEFAULT_OPEN.includes(activeTool));
    }
  }, [activeTool]);
  const showCode = useCallback(() => setDocumentOpen(false), []);
  const showDocument = useCallback(() => setDocumentOpen(true), []);
  // 必须包 useMemo：`logs` 分支里有内联 onClose，每次渲染都是新对象，
  // 会让下面 `dock` 的 useMemo 依赖整体失效（每次渲染都重建宿主导航绑定）
  const toolTab = useMemo(
    () =>
      activeTool === "logs"
        ? {
            ...DOCUMENT_TOOLS.logs,
            onClose: () => {
              setDocumentOpen(false);
              window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    '.wb-file-tabs [role="tab"][aria-selected="true"], .app-side-item[aria-label="代码"]',
                  )
                  ?.focus(),
              );
            },
          }
        : DOCUMENT_TOOLS[activeTool] ?? null,
    [activeTool],
  );
  const dock = useMemo(() => ({ hosts, fileHosts, bindHost: (name: DockRegionName) => refs[name], bindFileSlot: (name: FileSlotName) => fileRefs[name], showDocument, showCode, documentOpen, toolTab }), [hosts, fileHosts, refs, fileRefs, showDocument, showCode, documentOpen, toolTab]);
  const hasSide = SIDE_TOOLS.includes(activeTool);
  const hasToolbar = TOOLBAR_TOOLS.includes(activeTool);
  // 日志已有列表/详情两栏，不再占用资源树；元数据页自带组件清单，再摆一份文件树
  // 会变成双左栏、把主区挤窄。两页都保留用户在代码页设置的开合偏好。
  const sideShown = sideOpen && activeTool !== "logs" && activeTool !== "meta";
  const sideLabel = activeTool === "settings" ? "设置分类" : "资源侧栏";
  const closeSide = () => {
    setSideOpen(false);
    document.querySelector<HTMLElement>('[aria-label="工作台布局"]')?.focus();
  };
  // 底部面板有没有内容由 FilesTab 决定（它 portal 到宿主）；这里不再用 `output` 断言，
  // 空面板与分隔条靠 workbench-layout.css 的 `:empty` 规则收起。
  return <WorkbenchDockContext.Provider value={dock}>
    <ShowDocumentBridge show={showDocument} />
    <WorkspacePageMotion page={activeTool} target={pageRef} />
    <div className="wb-root" data-tool={activeTool}>
      <div ref={pageRef} className="wb-content-frame" data-page-panel>
      <header className="wb-toolbar" hidden={!hasToolbar}>
        <div ref={refs.toolbar} className="wb-toolbar-host" />
        <div ref={refs.actions} className="wb-toolbar-actions" />
      </header>
      <div className="wb-layout" data-side-open={sideShown} style={{ gridTemplateColumns: sideShown ? `${sideWidth}px 4px minmax(0,1fr)` : "0px 0px minmax(0,1fr)" }}>
        {/* 收起时不能用 hidden：display:none 的 aside 不占网格格子，后面的分隔条与主区会各前进一格，主区落进 0px 那一列 */}
        <button type="button" className="wb-side-backdrop" aria-label="收起侧栏" tabIndex={-1} hidden={!sideShown} onClick={closeSide} />
        <aside className="wb-tree" data-closed={!sideShown || undefined} onKeyDown={e => {
          if (e.key === "Escape" && !e.defaultPrevented && window.matchMedia?.("(max-width: 650px)").matches) {
            e.preventDefault(); e.stopPropagation(); closeSide();
          }
        }}>
          <div className="wb-tree-heading"><span>{sideLabel}</span><button type="button" className="wb-tree-close" aria-label={`关闭${sideLabel}`} onClick={closeSide}><Icon name="close" size={16} /></button></div>
          <div ref={fileRefs.tree} className="wb-tree-native" hidden={hasSide}>{tree}</div>
          <div ref={refs.sidebar} className="wb-sidebar-host" hidden={!hasSide} />
        </aside>
        <div className="wb-resize-x" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
          aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX} aria-valuenow={Math.round(sideWidth)}
          aria-hidden={!sideShown || undefined} tabIndex={sideShown ? 0 : -1} onPointerDown={e => { e.preventDefault(); resize("side", e.clientX, sideWidth); }} onKeyDown={e => onSeparatorKey(e, "side")} />
        <div className="wb-main-with-inspector">
        <section className="wb-main" data-service-mode={panelOpen && panelTab === "svc" || undefined} data-service-expanded={panelExpanded || undefined} data-panel-expanded={panelExpanded || undefined}>
          {/* 代码面自带文件标签条：切到工具页时整块 hidden，文件标签就不可能和
              文档面的工具标签同屏（以前两者挤在顶层 `wb-tabbar` 的同一条 flex 行里）。 */}
          <div
            id="wb-code-surface"
            className="wb-code-surface"
            role="tabpanel"
            aria-label="编辑器"
            hidden={documentOpen || panelExpanded}
          >
            <div ref={fileRefs.tabs} className="wb-file-tabs">{tabs}</div>
            <div ref={fileRefs.editor} className="wb-code-body">{editor}</div>
          </div>
          {/* 文档面同样自带标签条：多文档工具（数据库）停靠进 doctabs，
              单文档工具由 ToolTab 渲染。两个面互斥显示 ⇒ 两套标签永不同屏。 */}
          <div id="wb-document-surface" className="wb-document-surface" role="tabpanel" aria-label={toolTab?.label} hidden={!documentOpen || panelExpanded}>
            <div ref={refs.doctabs} className="wb-doc-tabs"><ToolTab /></div>
            <div ref={refs.document} className="wb-doc-body" />
          </div>
          <div hidden={panelExpanded} className="wb-resize-y" role="separator" aria-label="调整底部面板高度" aria-orientation="horizontal"
            aria-valuemin={BOTTOM_MIN} aria-valuemax={bottomMax} aria-valuenow={Math.round(bottomHeight)}
            tabIndex={0} onPointerDown={e => { e.preventDefault(); resize("bottom", e.clientY, bottomHeight); }} onKeyDown={e => onSeparatorKey(e, "bottom")} />
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
