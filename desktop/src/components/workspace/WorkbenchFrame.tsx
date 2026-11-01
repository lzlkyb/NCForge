import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { WorkbenchDockContext, type DockRegionName, type DockToolTab, type FileSlotName } from "./WorkbenchDock";
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
  linked: { label: "工程关联", icon: "plug" },
  settings: { label: "设置", icon: "settings" },
};
/**
 * 切到该工具时默认打开文档页。
 *
 * svn 有意不在列表里：打开版本控制先看源码，点「版本控制 · 差异」才切到差异，
 * 和用户从文件树点进来继续改代码的动线一致。少写这一句就会被当成漏配。
 */
const DOCUMENT_DEFAULT_OPEN = ["patch", "db", "linked", "settings"];
/** NC 服务的卡片 + 日志放在底部面板里，切过去时把面板撑高到够看。 */
const SERVICES_PANEL_MIN = 360;
const HOST_NAMES: DockRegionName[] = ["toolbar", "sidebar", "document", "bottom", "actions", "tabs"];
/** 文件页槽位：由 FilesTab 用 portal 注入（见 WorkbenchDock 的 FileSlotName）。 */
const FILE_SLOTS: FileSlotName[] = ["tree", "tabs", "editor", "status", "output"];

/** 侧栏 / 底部面板的尺寸。拖过就该记住：每次重启都回到 240 是白费用户的调整。 */
const SIZE_KEY = "ncforge-workbench-sizes";
const SIDE_MIN = 180;
const SIDE_MAX = 420;
const BOTTOM_MIN = 140;
// 键盘「双击 Enter 复位」回到的尺寸，与 loadSizes 的默认值保持同一处定义
const SIDE_DEFAULT = 240;
const BOTTOM_DEFAULT = 240;
const bottomMax = () => Math.max(BOTTOM_MIN, Math.round(window.innerHeight * 0.65));

function loadSizes(): { side: number; bottom: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "") as { side?: number; bottom?: number };
    const clamp = (n: unknown, lo: number, hi: number, dflt: number) =>
      typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
    return {
      side: clamp(v.side, SIDE_MIN, SIDE_MAX, SIDE_DEFAULT),
      bottom: clamp(v.bottom, BOTTOM_MIN, bottomMax(), BOTTOM_DEFAULT),
    };
  } catch {
    return { side: SIDE_DEFAULT, bottom: BOTTOM_DEFAULT };
  }
}

function saveSizes(s: { side: number; bottom: number }): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式 / 配额：只是不记住 */
  }
}

export function WorkbenchFrame({ activeTool, tool, fileTabs = false, tree, tabs, editor, output, status }: {
  activeTool: string; tool?: ReactNode;
  /**
   * 文件页标签是否已经由 portal 注入（= FilesTab 已挂载）。
   *
   * 为 true 时不再渲染 `ToolTab`：文件标签条已经在标签区里，再放一个工具标签
   * 会多出一个重复入口。首屏就是文件页，所以实际几乎恒为 true。
   */
  fileTabs?: boolean;
  tree: ReactNode; tabs: ReactNode;
  editor: ReactNode; output: ReactNode; status: ReactNode;
}) {
  const [hosts, setHosts] = useState<Record<DockRegionName, HTMLElement | null>>({ toolbar: null, sidebar: null, document: null, bottom: null, actions: null, tabs: null });
  const [fileHosts, setFileHosts] = useState<Record<FileSlotName, HTMLElement | null>>({ tree: null, tabs: null, editor: null, status: null, output: null });
  const [documentOpen, setDocumentOpen] = useState(false);
  const sideOpen = useSideOpen();
  const [sideWidth, setSideWidth] = useState(() => loadSizes().side);
  const [bottomHeight, setBottomHeight] = useState(() => loadSizes().bottom);
  // 每个宿主一个稳定的 ref 回调：回调身份变了 React 会先 null 再重填，宿主里的工具内容就闪一下
  const refs = useMemo(() => Object.fromEntries(HOST_NAMES.map(name => [name, (node: HTMLElement | null) => setHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<DockRegionName, (node: HTMLElement | null) => void>, []);
  const fileRefs = useMemo(() => Object.fromEntries(FILE_SLOTS.map(name => [name, (node: HTMLElement | null) => setFileHosts(old => old[name] === node ? old : { ...old, [name]: node })])) as Record<FileSlotName, (node: HTMLElement | null) => void>, []);
  useEffect(() => {
    setDocumentOpen(DOCUMENT_DEFAULT_OPEN.includes(activeTool));
    if (activeTool === "services") setBottomHeight(h => Math.max(h, SERVICES_PANEL_MIN));
  }, [activeTool]);
  const showCode = useCallback(() => setDocumentOpen(false), []);
  const showDocument = useCallback(() => setDocumentOpen(true), []);
  const toolTab = DOCUMENT_TOOLS[activeTool] ?? null;
  const dock = useMemo(() => ({ hosts, fileHosts, bindHost: (name: DockRegionName) => refs[name], bindFileSlot: (name: FileSlotName) => fileRefs[name], showDocument, showCode, documentOpen, toolTab }), [hosts, fileHosts, refs, fileRefs, showDocument, showCode, documentOpen, toolTab]);
  const hasSide = SIDE_TOOLS.includes(activeTool);
  const hasToolbar = TOOLBAR_TOOLS.includes(activeTool);
  // 底部面板有没有内容由 FilesTab 决定（它 portal 到宿主）；这里不再用 `output` 断言，
  // 空面板与分隔条靠 workbench-layout.css 的 `:empty` 规则收起。
  const resizeCleanup = useRef<(() => void) | null>(null);
  /** 两个分隔条各自记「上一次 Enter」的时间，互不干扰。 */
  const enterAt = useRef({ side: 0, bottom: 0 });
  useEffect(() => () => resizeCleanup.current?.(), []);
  // 防抖落盘：pointermove 里同步写 localStorage 会拖慢拖动本身
  useEffect(() => {
    const t = setTimeout(() => saveSizes({ side: sideWidth, bottom: bottomHeight }), 300);
    return () => clearTimeout(t);
  }, [sideWidth, bottomHeight]);
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
  /**
   * 分隔条键盘操作：方向键 ±10px；同一个分隔条 600ms 内按两次 Enter 复位默认尺寸。
   * 键盘用户没有「双击分隔条」这种鼠标手势，只靠方向键一格格挪回去太慢。
   */
  const onSeparatorKey = (e: ReactKeyboardEvent, axis: "side" | "bottom") => {
    if (e.key === "Enter") {
      e.preventDefault();
      const now = performance.now();
      if (now - enterAt.current[axis] < 600) {
        enterAt.current[axis] = 0;
        if (axis === "side") setSideWidth(SIDE_DEFAULT);
        else setBottomHeight(BOTTOM_DEFAULT);
      } else {
        enterAt.current[axis] = now;
      }
      return;
    }
    const grow = axis === "side" ? "ArrowRight" : "ArrowUp";
    const shrink = axis === "side" ? "ArrowLeft" : "ArrowDown";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const delta = e.key === grow ? 10 : -10;
    if (axis === "side") setSideWidth((w) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, w + delta)));
    else setBottomHeight((h) => Math.max(BOTTOM_MIN, Math.min(bottomMax(), h + delta)));
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
          <div ref={fileRefs.tree} className="wb-tree-native" hidden={hasSide}>{tree}</div>
          <div ref={refs.sidebar} className="wb-sidebar-host" hidden={!hasSide} />
        </aside>
        <div className="wb-resize-x" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
          aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX} aria-valuenow={Math.round(sideWidth)}
          tabIndex={0} onPointerDown={e => { e.preventDefault(); resize("side", e.clientX, sideWidth); }} onKeyDown={e => onSeparatorKey(e, "side")} />
        <section className="wb-main">
          <div className="wb-tabbar">
            <div ref={fileRefs.tabs} className="wb-file-tabs">{tabs}</div>
            {!fileTabs && <div className="wb-tabs" role="tablist"><ToolTab /></div>}
          </div>
          <div id="wb-code-surface" ref={fileRefs.editor} className="wb-code-surface" role="tabpanel" aria-label="编辑器" hidden={documentOpen}>{editor}</div>
          <div ref={refs.document} className="wb-document-surface" hidden={!documentOpen} />
          <div className="wb-resize-y" role="separator" aria-label="调整底部面板高度" aria-orientation="horizontal"
            aria-valuemin={BOTTOM_MIN} aria-valuemax={bottomMax()} aria-valuenow={Math.round(bottomHeight)}
            tabIndex={0} onPointerDown={e => { e.preventDefault(); resize("bottom", e.clientY, bottomHeight); }} onKeyDown={e => onSeparatorKey(e, "bottom")} />
          <div ref={fileRefs.output} className="wb-bottom" style={{ height: bottomHeight }}>{output}</div>
        </section>
      </div>
      <div ref={fileRefs.status} className="wb-status-host">{status}</div>
      <div className="wb-tool-runtime">{tool}</div>
    </div>
  </WorkbenchDockContext.Provider>;
}
