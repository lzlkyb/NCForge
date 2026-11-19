import type { monaco } from "./monacoSetup";
import type { SqlActionPreview, SqlCodeAction } from "./sqlBillAssist";
import { billJoinGroupLabels } from "./sqlBillJoin";

type Action = { action: SqlCodeAction };
type MenuRow = {
  kind: "header" | "action";
  group?: { title: string };
  item?: Action;
  label?: string;
  keybinding?: { getLabel(): string | null };
};
type Delegate = { onFocus?: (item?: Action) => void };
type ActionList = {
  domNode: HTMLElement;
  layout(minWidth: number): number;
  focusNext(): void;
  _list: {
    length: number;
    contentHeight: number;
    view: { virtualDelegate: { getHeight(row: MenuRow): number } };
    splice(start: number, count: number, items: MenuRow[]): void;
    layout(height: number, width: number): void;
    domFocus(): void;
    getFocus(): number[];
    setFocus(indexes: number[]): void;
    reveal(index: number): void;
  };
};
interface ActionWidgetService {
  isVisible: boolean;
  hide(cancelled?: boolean): void;
  focusPrevious(): void;
  focusNext(): void;
  acceptSelected(preview?: boolean): void;
  show(user: string, preview: boolean, rows: MenuRow[], delegate: Delegate, anchor: unknown, container: HTMLElement, actions?: unknown[]): void;
  _renderWidget(view: HTMLElement, list: ActionList, actions: unknown[]): monaco.IDisposable;
  _contextViewService: { layout(): void };
}

const header = (title: string): MenuRow => ({ kind: "header", group: { title } });
const previewOf = (action?: SqlCodeAction): SqlActionPreview | undefined => action?.ncforgePreview
  ?? (action?.ncforgeJoin ? { text: action.ncforgeJoin.sql.trim() } : undefined);
function sqlMenuRows(rows: MenuRow[]): MenuRow[] {
  const joins = rows.filter(row => row.item?.action.ncforgeJoin);
  const result: MenuRow[] = [];
  if (joins.length) {
    const append = joins[0].item?.action.ncforgeJoin?.mode === "append";
    result.push(header(append ? "主子表联查 · 追加 LEFT JOIN" : "主子表联查 · 生成查询"));
    for (const group of ["detail", "related", "lookup"] as const) {
      const groupRows = joins.filter(row => row.item?.action.ncforgeJoin?.group === group);
      if (!groupRows.length) continue;
      result.push(header(billJoinGroupLabels[group]), ...groupRows.map(row => {
        const item = row.item!.action.ncforgeJoin!;
        return { ...row, label: item.label === item.table ? item.table : `${item.label} · ${item.table}` };
      }));
    }
  }
  let group: MenuRow | undefined;
  for (const row of rows) {
    if (row.kind === "header") { group = row; continue; }
    if (row.item?.action.ncforgeJoin) continue;
    if (group) {
      result.push(header(group.group?.title === "Quick Fix" ? "查询修正" : "SQL 操作"));
      group = undefined;
    }
    result.push(row);
  }
  return result;
}

function fitActionList(list: ActionList, rows: MenuRow[], minWidth: number, hasPreview: boolean, requiresChoice: boolean): number {
  const node = list.domNode, doc = node.ownerDocument, virtual = list._list;
  const style = getComputedStyle(node), canvas = doc.createElement("canvas").getContext("2d");
  if (canvas) canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const widthOf = (text: string) => canvas?.measureText(text).width ?? text.length * 13;
  const gutter = 56; // Leave room for the icon, list padding and scrollbar.
  const cap = Math.min(760, doc.documentElement.clientWidth - 32);
  const widths = rows.map(row => ({
    label: (row.label ?? row.group?.title ?? "").replace(/[\r\n]/g, " "),
    keys: row.keybinding?.getLabel() ?? "",
  }));
  const desired = Math.max(280, minWidth, ...widths.map(row => widthOf(row.label) + (row.keys ? widthOf(row.keys) + 28 : 0) + gutter));
  const width = Math.ceil(Math.min(cap, desired));
  const measure = doc.createElement("span");
  measure.className = "dbx-sql-action-measure";
  node.append(measure);
  const heights = new Map<MenuRow, number>();
  const delegate = virtual.view.virtualDelegate, defaultHeight = delegate.getHeight;
  rows.forEach((row, index) => {
    if (row.kind !== "action") return;
    const { label, keys } = widths[index];
    const space = Math.max(1, width - gutter - (keys ? widthOf(keys) + 28 : 0));
    if (widthOf(label) <= space) return;
    measure.style.width = `${space}px`;
    measure.textContent = label;
    heights.set(row, Math.max(defaultHeight(row), measure.offsetHeight + 6));
  });
  measure.remove();
  delegate.getHeight = row => heights.get(row) ?? defaultHeight(row);
  virtual.splice(0, virtual.length, rows);
  const height = Math.min(virtual.contentHeight, Math.floor(doc.documentElement.clientHeight * (hasPreview ? .55 : .70)));
  virtual.layout(height, width);
  node.style.height = `${height}px`;
  if (requiresChoice) virtual.setFocus([]);
  else list.focusNext();
  virtual.domFocus();
  return width;
}

/** Keep Monaco's code action discovery, versioned edits and keyboard handling. Scope the view to this SQL editor. */
export function wireSqlActionMenu(editor: monaco.editor.IStandaloneCodeEditor, portal: HTMLElement): monaco.IDisposable {
  // Monaco 0.52 has no public action-menu renderer hook. Its controller calls the service synchronously.
  type ControllerService = Pick<ActionWidgetService, "show" | "hide" | "isVisible">;
  const controller = editor.getContribution("editor.contrib.codeActionController") as unknown as { _actionWidgetService?: ControllerService } | null;
  const service = controller?._actionWidgetService as ActionWidgetService | undefined;
  if (!controller || !service?._renderWidget || !service.show) return { dispose() {} };
  let currentView: HTMLElement | undefined;
  const show: ControllerService["show"] = (user, preview, rows, delegate, anchor, container, actions) => {
    const menu = sqlMenuRows(rows), render = service._renderWidget;
    const hasPreview = menu.some(row => previewOf(row.item?.action));
    const requiresChoice = menu.some(row => row.item?.action.ncforgePreview);
    let showPreview: ((action?: SqlCodeAction) => void) | undefined;
    let nativeList: ActionList | undefined;
    service._renderWidget = (view, list, bar) => {
      currentView = view;
      nativeList = list;
      view.classList.add("dbx-sql-action-view");
      list.layout = min => fitActionList(list, menu, min, hasPreview, requiresChoice);
      const rendered = render.call(service, view, list, bar);
      const widget = list.domNode.parentElement;
      const doc = view.ownerDocument;
      const panel = hasPreview && widget ? doc.createElement("details") : undefined;
      if (requiresChoice && widget) {
        const help = doc.createElement("div");
        help.className = "dbx-sql-action-keys";
        help.textContent = "↑↓ 选择 · → 预览 · Enter 应用 · Esc 关闭";
        widget.append(help);
      }
      let generation = 0, selected: SqlCodeAction | undefined;
      // fixed ContextView 重复 layout 的自减坐标坑由 monacoContextViewGuard 统一归零兜底。
      const reposition = () => service._contextViewService.layout();
      let relayout = () => reposition();
      if (panel && widget) {
        // 用 visibility 而非 hidden：焦点扫过标题行/无预览行时面板若退出布局，widget 高度
        // 变化会触发 relayout，浮层在鼠标下移位又改变悬停行，形成来回跳动的反馈环。
        panel.style.visibility = "hidden";
        panel.className = "dbx-sql-action-preview";
        const summary = doc.createElement("summary"), code = doc.createElement("pre");
        summary.textContent = "查看 SQL 预览（→）";
        panel.append(summary, code);
        widget.append(panel);
        const update = () => {
          const info = previewOf(selected), id = ++generation;
          if (!info || !panel.open) { code.textContent = ""; return; }
          if ("text" in info) { code.textContent = info.text; return; }
          code.textContent = "正在读取字段，生成预览…";
          const current = () => generation === id && panel.isConnected && panel.open;
          void info.read(current).then(text => { if (current()) { code.textContent = text; reposition(); } }, error => {
            if (current()) { code.textContent = error instanceof Error ? error.message : "暂时无法预览，请重试。"; reposition(); }
          });
        };
        showPreview = action => {
          // 标题行被鼠标悬停也会拿焦点（Monaco mouseover 直接 setFocus）：保持上一份预览，别动面板。
          if (!action) return;
          if (selected === action && panel.style.visibility !== "hidden") return;
          selected = action;
          const info = previewOf(action);
          panel.style.visibility = info ? "" : "hidden";
          if (!info) panel.open = false;
          summary.textContent = info && "description" in info && info.description ? "查看操作说明（→）" : "查看 SQL 预览（→）";
          update(); reposition();
        };
        relayout = () => { update(); reposition(); };
        showPreview(menu[list._list.getFocus()[0]]?.item?.action);
        panel.addEventListener("toggle", relayout);
      }
      const keys = (event: KeyboardEvent) => {
        if (event.isComposing) return;
        const fromList = list.domNode.contains(event.target as Node);
        const previewable = panel && panel.style.visibility !== "hidden";
        // The popup lives at window level so the editor's DOM keybinding listener cannot see it.
        if (event.key === "Escape") service.hide(true);
        else if (!fromList) return;
        else if (event.key === "ArrowUp") service.focusPrevious();
        else if (event.key === "ArrowDown") service.focusNext();
        else if (previewable && (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "F2" && event.shiftKey)) {
          panel.open = event.key !== "ArrowLeft";
        }
        else if (event.key === "Enter" || event.key === "F2") service.acceptSelected(event.key === "F2" && event.shiftKey);
        else return;
        event.preventDefault(); event.stopPropagation();
      };
      view.addEventListener("keydown", keys, true);
      return { dispose() { generation++; panel?.removeEventListener("toggle", relayout); view.removeEventListener("keydown", keys, true); rendered.dispose(); } };
    };
    try {
      service.show(user, preview, menu, { ...delegate, onFocus: item => {
        delegate.onFocus?.(item);
        const index = nativeList?._list.getFocus()[0];
        if (index !== undefined) nativeList?._list.reveal(index);
        showPreview?.(item?.action);
      } }, anchor, portal.isConnected ? portal : container, actions);
    } finally { service._renderWidget = render; }
  };
  controller._actionWidgetService = { show, hide: cancelled => service.hide(cancelled), get isVisible() { return service.isVisible; } };
  return { dispose() {
    if (currentView?.classList.contains("dbx-sql-action-view") && portal.contains(currentView)) service.hide(true);
    controller._actionWidgetService = service;
  } };
}
