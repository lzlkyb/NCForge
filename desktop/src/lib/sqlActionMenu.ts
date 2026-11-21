import type { monaco } from "./monacoSetup";
import type { SqlActionPreview, SqlCodeAction, SqlJoinBatch, SqlJoinPresentation } from "./sqlBillAssist";
import { billJoinGroupLabels } from "./sqlBillJoin";
import { createSqlAssistPreview } from "./sqlAssistPreview";
import { dialectOfSqlModel } from "./monacoSql";
import "../sql-join-icons.css";

type Action = { action: SqlCodeAction };
type MenuRow = {
  kind: "header" | "action";
  group?: { title: string; icon?: { id: string } };
  item?: Action;
  label?: string;
  joinLabel?: { title: string; detail: string };
  disabled?: string;
  keybinding?: { getLabel(): string | null };
};
type Delegate = { onFocus?: (item?: Action) => void; onSelect?: (item: Action, preview: boolean) => void };
type ActionRenderer = { renderElement(row: MenuRow, index: number, data: { container: HTMLElement; text: HTMLElement; check?: HTMLInputElement }, height?: number): void };
type ActionList = {
  domNode: HTMLElement;
  layout(minWidth: number): number;
  _list: {
    length: number;
    contentHeight: number;
    view: { virtualDelegate: { getHeight(row: MenuRow): number }; renderers?: Map<string, { renderers: ActionRenderer[] }> };
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
    const counts = new Map<string, number>();
    for (const row of joins) {
      const table = row.item!.action.ncforgeJoin!.table;
      counts.set(table, (counts.get(table) ?? 0) + 1);
    }
    const decorate = (row: MenuRow): MenuRow => {
      const item = row.item!.action.ncforgeJoin!;
      const label = item.label === item.table ? item.table : `${item.label} · ${item.table}`;
      const fields = (counts.get(item.table) ?? 0) > 1 ? item.rootColumns.join(" + ") : "";
      const icon = `ncforge-join-${item.icon}`;
      const joinLabel = item.mode === "append" ? { title: item.label, detail: [item.label === item.table ? "" : item.table, item.rootColumns.join(" + ")].filter(Boolean).join(" · ") } : undefined;
      return { ...row, joinLabel, group: { title: label, icon: { id: icon } }, label: fields ? `${label} · ${fields}` : label };
    };
    const rank = (row: MenuRow) => row.item?.action.ncforgeJoin?.usageRank ?? 0;
    const common = joins.filter(row => !row.disabled && rank(row) > 0).sort((a, b) => rank(b) - rank(a)).slice(0, 3);
    const promoted = new Set(common);
    if (common.length) result.push(header("常用关联"), ...common.map(decorate));
    for (const group of ["detail", "related", "lookup"] as const) {
      const groupRows = joins.filter(row => !promoted.has(row) && row.item?.action.ncforgeJoin?.group === group);
      if (groupRows.length) result.push(header(billJoinGroupLabels[group]), ...groupRows.map(decorate));
    }
  }
  let group: MenuRow | undefined;
  for (const row of rows) {
    if (row.kind === "header") { group = row; continue; }
    if (row.item?.action.ncforgeJoin || row.item?.action.ncforgeJoinBatch) continue;
    if (group) {
      result.push(header(group.group?.title === "Quick Fix" ? "查询修正" : "SQL 操作"));
      group = undefined;
    }
    const icon = row.item?.action.ncforgePreview?.icon;
    result.push(icon ? { ...row, group: { title: row.label ?? row.item!.action.title, icon: { id: icon } } } : row);
  }
  return result;
}

function fitActionList(list: ActionList, rows: MenuRow[], minWidth: number, cap: number, hasPreview: boolean, requiresChoice: boolean): number {
  const node = list.domNode, doc = node.ownerDocument, virtual = list._list;
  const style = getComputedStyle(node), canvas = doc.createElement("canvas").getContext("2d");
  if (canvas) canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const widthOf = (text: string) => canvas?.measureText(text).width ?? text.length * 13;
  const gutter = 56; // Leave room for the icon, list padding and scrollbar.
  const widths = rows.map(row => ({
    label: (row.label ?? row.group?.title ?? "").replace(/[\r\n]/g, " "), lines: row.joinLabel ? [row.joinLabel.title, row.joinLabel.detail] : [],
    keys: row.keybinding?.getLabel() ?? "",
  }));
  const desired = Math.max(280, minWidth, ...widths.map(row => row.lines.length
    ? Math.max(...row.lines.map(widthOf)) + gutter + 22 : widthOf(row.label) + (row.keys ? widthOf(row.keys) + 28 : 0) + gutter));
  const width = Math.ceil(Math.min(cap, desired));
  const measure = doc.createElement("span");
  measure.className = "dbx-sql-action-measure";
  node.append(measure);
  const heights = new Map<MenuRow, number>();
  const delegate = virtual.view.virtualDelegate, defaultHeight = delegate.getHeight;
  rows.forEach((row, index) => {
    if (row.kind !== "action") return;
    const { label, keys, lines } = widths[index];
    const space = Math.max(1, width - gutter - (lines.length ? 22 : 0) - (keys ? widthOf(keys) + 28 : 0));
    const rowHeight = Math.max(defaultHeight(row), lines.length ? 38 : 28);
    const textLines = lines.length ? lines : [label];
    if (textLines.every(text => widthOf(text) <= space)) { heights.set(row, rowHeight); return; }
    measure.style.width = `${space}px`;
    const textHeight = textLines.reduce((height, text) => { measure.textContent = text; return height + measure.offsetHeight; }, 0);
    heights.set(row, Math.max(rowHeight, textHeight + 8));
  });
  measure.remove();
  delegate.getHeight = row => heights.get(row) ?? defaultHeight(row);
  virtual.splice(0, virtual.length, rows);
  const height = Math.min(virtual.contentHeight, Math.floor(doc.documentElement.clientHeight * (hasPreview ? .39 : .70)));
  virtual.layout(height, width);
  node.style.height = `${height}px`;
  virtual.setFocus(requiresChoice ? [] : [rows.findIndex(row => row.kind === "action" && !row.disabled)].filter(index => index >= 0));
  virtual.domFocus();
  return width;
}

function wireJoinBatch(batch: SqlJoinBatch, widget: HTMLElement, list: ActionList, view: ReturnType<typeof createSqlAssistPreview>,
  getRows: () => MenuRow[], setRows: (choices: SqlCodeAction[], added: SqlJoinPresentation[]) => void, hide: (cancelled: boolean) => void) {
  const doc = widget.ownerDocument;
  const picked = new Set<SqlJoinPresentation>();
  let source = batch.source, added = batch.added, showAdded = false, revision = 0;
  let choices = getRows().flatMap(row => row.item?.action.ncforgeJoin?.mode === "append" ? [row.item.action] : []);
  let focused = choices[0]?.ncforgeJoin;
  const sourceBar = doc.createElement("div"), sourceLabel = doc.createElement("label");
  const sourceSelect = batch.sources.length > 1 ? doc.createElement("select") : doc.createElement("code");
  const history = doc.createElement("button"), apply = doc.createElement("button"), applyLabel = doc.createElement("span");
  const placement = doc.createElement("div");
  sourceBar.className = "dbx-sql-join-source";
  sourceLabel.append("关联来源", sourceSelect);
  if (sourceSelect instanceof HTMLSelectElement) {
    for (const item of batch.sources) {
      const option = doc.createElement("option");
      option.value = String(item.id); option.textContent = item.label;
      sourceSelect.append(option);
    }
    sourceSelect.value = String(source);
  } else sourceSelect.textContent = batch.sources[0]?.label ?? "";
  history.type = apply.type = "button";
  history.className = "dbx-sql-join-added";
  apply.className = "dbx-sql-join-apply";
  const enter = doc.createElement("kbd");
  enter.textContent = "Enter"; enter.setAttribute("aria-hidden", "true");
  apply.append(applyLabel, enter);
  const space = doc.createElement("span"), key = doc.createElement("kbd");
  key.textContent = "Space"; space.append(key, "勾选");
  view.footer.querySelector("[data-sql-apply]")?.replaceWith(space);
  view.footer.append(apply);
  placement.className = "dbx-sql-join-placement";
  placement.textContent = batch.clause ? "插入到 " + batch.clause + " 前" : "追加到当前查询的关联末尾";
  view.panel.append(placement);
  sourceBar.append(sourceLabel, history);
  widget.dataset.sqlJoinBatch = "";
  widget.append(sourceBar);
  const display = (status?: "loading" | "error") => {
    const items = picked.size ? [...picked] : focused ? [focused] : [];
    const selection = picked.size ? "已选 " + picked.size + " 条关联"
      : focused && [focused.table, focused.rootColumns.join(" + ")].join(" · ");
    const origins = [...new Set(items.map(item => item.relationSource).filter(Boolean))];
    const note = [items.some(item => item.mayRepeatRows) && "主表行可能重复", selection,
      origins.slice(0, 3).join("、"), origins.length > 3 && `另有 ${origins.length - 3} 种来源`].filter(Boolean).join(" · ");
    placement.hidden = !items.length || !!status;
    apply.disabled = !items.length || !!status;
    applyLabel.textContent = picked.size ? "添加 " + picked.size + " 条关联" : "添加关联";
    history.hidden = !added.length;
    history.textContent = "已添加（" + added.length + "）";
    history.setAttribute("aria-expanded", String(showAdded));
    view.update({ text: status === "loading" ? "正在读取关联…" : status === "error" ? "暂时无法读取此表的关联"
      : items.length ? batch.preview(items) : "当前来源没有可添加的关联",
    status: status ?? (items.length ? undefined : "empty"), note: note || undefined,
    icon: !picked.size && focused ? `ncforge-join-${focused.icon}` : undefined }, "主子表联查", "追加 LEFT JOIN");
  };
  function sync(row: HTMLElement, item?: SqlJoinPresentation) {
    const checked = !!item && picked.has(item);
    const check = row.querySelector<HTMLInputElement>(".dbx-sql-join-check");
    if (check) check.checked = checked;
    row.toggleAttribute("data-sql-join-picked", checked);
  }
  const actionRenderer = list._list.view.renderers?.get("action")?.renderers.slice(-1)[0];
  const render = actionRenderer?.renderElement;
  if (actionRenderer && render) actionRenderer.renderElement = function(row, index, data, height) {
    render.call(this, row, index, data, height);
    const item = row.joinLabel && row.item?.action.ncforgeJoin;
    data.container.toggleAttribute("data-sql-join-row", !!item);
    if (item && row.joinLabel) {
      const title = doc.createElement("span"), detail = doc.createElement("small");
      title.textContent = row.joinLabel.title; detail.textContent = row.joinLabel.detail;
      data.text.replaceChildren(title, " ", detail);
      if (!data.check) {
        data.check = doc.createElement("input");
        data.check.type = "checkbox";
        data.check.tabIndex = -1;
        data.check.className = "dbx-sql-join-check";
      }
      data.check.setAttribute("aria-label", [row.joinLabel.title, row.joinLabel.detail].join(" · "));
      if (row.disabled) data.check.remove();
      else if (data.check.parentElement !== data.container) data.container.prepend(data.check);
    } else data.check?.remove();
    sync(data.container, item || undefined);
  };
  const focus = (item?: SqlJoinPresentation) => { focused = item; if (!picked.size) display(); };
  const toggle = (item?: SqlJoinPresentation) => {
    if (!item) return;
    if (!picked.delete(item)) picked.add(item);
    focused = item;
    list.domNode.querySelectorAll<HTMLElement>(".monaco-list-row[data-sql-join-row]").forEach(row =>
      sync(row, getRows()[Number(row.dataset.index)]?.item?.action.ncforgeJoin));
    display();
  };
  const accept = (item = focused) => {
    const selection = picked.size ? [...picked] : item ? [item] : [];
    if (!selection.length) return;
    if (!batch.current()) { hide(true); return; }
    if (batch.apply(source, selection)) hide(false);
  };
  const suppressCheckboxFocus = (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest(".dbx-sql-join-check")) return;
    event.preventDefault(); event.stopPropagation();
  };
  const focusRow = (event: MouseEvent, clicking: boolean) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".monaco-list-row[data-sql-join-row]");
    if (!row) return;
    const index = Number(row.dataset.index), entry = getRows()[index];
    if (!entry?.item?.action.ncforgeJoin || entry.disabled) return;
    // Native action hover replaces the virtual row. Keep the checkbox mounted through pointer down/up.
    event.stopPropagation();
    if (list._list.getFocus()[0] !== index) list._list.setFocus([index]);
    if (clicking) {
      if (target.closest(".dbx-sql-join-check")) toggle(entry.item.action.ncforgeJoin);
      list._list.domFocus();
    }
  };
  const hover = (event: MouseEvent) => focusRow(event, false);
  const click = (event: MouseEvent) => focusRow(event, true);
  list.domNode.addEventListener("mousedown", suppressCheckboxFocus, true);
  list.domNode.addEventListener("mouseover", hover, true);
  list.domNode.addEventListener("click", click, true);
  apply.addEventListener("click", () => accept());
  history.addEventListener("click", () => {
    showAdded = !showAdded;
    setRows(choices, showAdded ? added : []);
    display();
  });
  sourceSelect.addEventListener("change", async () => {
    if (!(sourceSelect instanceof HTMLSelectElement)) return;
    const request = ++revision;
    source = Number(sourceSelect.value);
    picked.clear(); focused = undefined; added = []; choices = []; showAdded = false;
    setRows([], []);
    display("loading");
    try {
      const next = await batch.read(source);
      if (request !== revision || !batch.current()) return;
      choices = next.actions; added = next.added;
      setRows(choices, []);
      focused = getRows().find(row => row.kind === "action" && !row.disabled)?.item?.action.ncforgeJoin;
      display();
    } catch {
      if (request === revision) display("error");
    }
  });
  // The native action list has static row heights. Reinsert its visible rows to run the renderer hook.
  const focusBeforeRender = list._list.getFocus();
  list._list.splice(0, list._list.length, getRows());
  list._list.setFocus(focusBeforeRender);
  display();
  return { focus, toggle, accept, hasPicked: () => !!picked.size, dispose() {
    revision++;
    if (actionRenderer && render) actionRenderer.renderElement = render;
    list.domNode.removeEventListener("mousedown", suppressCheckboxFocus, true);
    list.domNode.removeEventListener("mouseover", hover, true);
    list.domNode.removeEventListener("click", click, true);
  } };
}

/** Keep Monaco's code action discovery, versioned edits and keyboard handling. Scope the view to this SQL editor. */
export function wireSqlActionMenu(editor: monaco.editor.IStandaloneCodeEditor, portal: HTMLElement): monaco.IDisposable {
  // Monaco 0.52 has no public action-menu renderer hook. Its controller calls the service synchronously.
  type ControllerService = Pick<ActionWidgetService, "show" | "hide" | "isVisible">;
  const controller = editor.getContribution("editor.contrib.codeActionController") as unknown as { _actionWidgetService?: ControllerService } | null;
  const service = controller?._actionWidgetService as ActionWidgetService | undefined;
  if (!controller || !service?._renderWidget || !service.show) return { dispose() {} };
  const editorNode = editor.getContainerDomNode();
  let currentView: HTMLElement | undefined;
  const show: ControllerService["show"] = (user, preview, rows, delegate, anchor, container, actions) => {
    const win = portal.ownerDocument.defaultView!;
    const caret = editor.getPosition(), editorBox = editor.getDomNode()?.getBoundingClientRect();
    const line = caret && editor.getScrolledVisiblePosition(caret);
    const lineVisible = line && editorBox && line.top >= 0 && line.top + line.height <= editorBox.height;
    const point = anchor as { x?: number; y?: number } | undefined;
    const lineHeight = line?.height ?? 0;
    // The native point sits below the caret. Reserve the entire line so flipping above keeps it readable.
    const y = lineVisible ? editorBox.top + line.top + win.scrollY : (point?.y ?? 0) - lineHeight;
    const lineAnchor = lineHeight && (lineVisible || typeof point?.y === "number") ? {
      x: lineVisible ? editorBox.left + line.left + win.scrollX : point?.x ?? 0,
      y, height: lineHeight,
    } : undefined;
    const availableHeight = lineAnchor ? Math.floor(Math.max(y - win.scrollY, win.innerHeight - (y - win.scrollY + lineHeight))) : win.innerHeight;
    let menu = sqlMenuRows(rows);
    const render = service._renderWidget;
    const batch = rows.find(row => row.item?.action.ncforgeJoinBatch)?.item?.action.ncforgeJoinBatch;
    const hasPreview = !!batch || menu.some(row => previewOf(row.item?.action));
    const join = menu.find(row => row.item?.action.ncforgeJoin)?.item?.action.ncforgeJoin;
    const requiresChoice = menu.some(row => row.item?.action.ncforgePreview && !row.item.action.ncforgeJoin);
    let showPreview: ((action?: SqlCodeAction) => void) | undefined;
    let batchMenu: ReturnType<typeof wireJoinBatch> | undefined;
    let nativeList: ActionList | undefined;
    service._renderWidget = (view, list, bar) => {
      currentView = view;
      editorNode?.setAttribute("data-sql-action-open", "");
      nativeList = list;
      view.classList.add("dbx-sql-action-view");
      const doc = view.ownerDocument;
      const widthBudget = doc.documentElement.clientWidth - 44;
      const previewWidth = hasPreview ? Math.min(414, Math.floor(widthBudget * .53)) : 0;
      const frameWidth = 2;
      // Split the same viewport budget so the right pane fits even at the desktop minimum width.
      const listCap = hasPreview ? Math.min(360, widthBudget - previewWidth - frameWidth) : Math.min(760, widthBudget);
      let listWidth = 0;
      const defaultHeight = list._list.view.virtualDelegate.getHeight;
      list.layout = min => listWidth = fitActionList(list, menu, min, listCap, hasPreview, requiresChoice);
      const rendered = render.call(service, view, list, bar);
      const widget = list.domNode.parentElement;
      const previewView = hasPreview && widget ? createSqlAssistPreview(doc, () => {
        const model = editor.getModel();
        return model ? dialectOfSqlModel(model) : "sql";
      }) : undefined;
      const code = previewView?.code;
      if (previewView && widget && code) {
        widget.dataset.sqlPreview = "side";
        widget.style.setProperty("--sql-action-list-width", `${listWidth}px`);
        widget.style.width = `${listWidth + frameWidth + previewWidth}px`;
        // Give the preview room even for a short list. Selecting a row only swaps its contents.
        widget.style.setProperty("--sql-action-body-height", `${Math.max(list.domNode.offsetHeight, Math.min(178, doc.documentElement.clientHeight * .29))}px`);
        code.tabIndex = 0;
        code.setAttribute("aria-label", "SQL 预览内容");
        widget.prepend(previewView.top);
        widget.append(previewView.panel, previewView.footer);

        let selected: SqlCodeAction | undefined;
        const update = (action?: SqlCodeAction) => {
          selected = action;
          const info = previewOf(action), selectedJoin = action?.ncforgeJoin;
          const note = selectedJoin ? [selectedJoin.table, selectedJoin.rootColumns.join(" + ")].filter(Boolean).join(" · ") : info?.note;
          previewView.update(info && { ...info, note, icon: selectedJoin ? `ncforge-join-${selectedJoin.icon}` : info.icon }, join ? "主子表联查" : "SQL 操作",
            join ? join.mode === "append" ? "追加 LEFT JOIN" : "生成查询" : "");
        };
        showPreview = action => {
          // Hovering a group header keeps the last preview without changing the anchor.
          if (!action) return;
          if (batchMenu) {
            batchMenu.focus(action.ncforgeJoin);
            if (action.ncforgeJoin || batchMenu.hasPicked()) return;
          }
          if (selected !== action || batchMenu) update(action);
        };
        update((menu[list._list.getFocus()[0]] ?? menu.find(row => !row.disabled && previewOf(row.item?.action)))?.item?.action);
        if (batch) {
          if (list._list.getFocus().length === 0) {
            const index = menu.findIndex(row => row.item?.action.ncforgeJoin);
            if (index >= 0) list._list.setFocus([index]);
          }
          const other = rows.filter(row => !row.item?.action.ncforgeJoinBatch);
          const asRow = (action: SqlCodeAction): MenuRow => ({ kind: "action", item: { action }, label: action.title });
          batchMenu = wireJoinBatch(batch, widget, list, previewView, () => menu, (choices, added) => {
            const available = choices.map(asRow);
            menu = sqlMenuRows([...available, ...other]);
            if (added.length) {
              const history = added.map(item => ({ ...asRow({ title: item.label, ncforgeJoin: item }), disabled: "已添加" }));
              menu.push(header("已添加"), ...sqlMenuRows(history).filter(row => row.kind === "action"));
            }
            const height = list.domNode.offsetHeight;
            list._list.view.virtualDelegate.getHeight = defaultHeight;
            fitActionList(list, menu, listWidth, listWidth, true, false);
            list._list.layout(height, listWidth);
            list.domNode.style.height = `${height}px`;
          }, cancelled => service.hide(cancelled));
        }
      }
      const bodyHeight = previewView && widget
        ? parseFloat(widget.style.getPropertyValue("--sql-action-body-height")) : list.domNode.offsetHeight;
      const cap = Math.max(1, availableHeight - (view.offsetHeight - bodyHeight));
      if (bodyHeight > cap) widget?.style.setProperty("--sql-action-body-height", `${cap}px`);
      if (batch || bodyHeight > cap) {
        const listHeight = Math.min(cap, batch ? bodyHeight : list.domNode.offsetHeight);
        list._list.layout(listHeight, listWidth);
        list.domNode.style.height = `${listHeight}px`;
      }
      const keys = (event: KeyboardEvent) => {
        if (event.isComposing) return;
        const fromList = list.domNode.contains(event.target as Node);
        // The popup lives at window level so the editor's DOM keybinding listener cannot see it.
        if (event.key === "Escape") service.hide(true);
        else if (event.target === code && event.key === "ArrowLeft") list._list.domFocus();
        else if (!fromList) return;
        else if (event.key === "ArrowUp") service.focusPrevious();
        else if (event.key === "ArrowDown") service.focusNext();
        else if (code && (event.key === "ArrowRight" || event.key === "F2" && event.shiftKey)) code.focus();
        else if (batchMenu && event.key === " ") batchMenu.toggle(menu[list._list.getFocus()[0]]?.item?.action.ncforgeJoin);
        else if (batchMenu?.hasPicked() && event.key === "Enter") batchMenu.accept();
        else if (event.key === "Enter" || event.key === "F2") service.acceptSelected(event.key === "F2" && event.shiftKey);
        else return;
        event.preventDefault(); event.stopPropagation();
      };
      view.addEventListener("keydown", keys, true);
      return { dispose() {
        if (currentView === view) {
          currentView = undefined;
          editorNode?.removeAttribute("data-sql-action-open");
        }
        batchMenu?.dispose(); previewView?.clear(); view.removeEventListener("keydown", keys, true); rendered.dispose();
      } };
    };
    try {
      service.show(user, preview, menu, { ...delegate, onSelect: (item, preview) => {
        const current = previewOf(item.action)?.current;
        if (current && !current()) { service.hide(true); return; }
        if (batchMenu && item.action.ncforgeJoin?.mode === "append") {
          if (!preview) batchMenu.accept(item.action.ncforgeJoin);
          return;
        }
        if (!item.action.ncforgeApply || preview) { delegate.onSelect?.(item, preview); return; }
        if (item.action.ncforgeApply()) service.hide(false);
      }, onFocus: item => {
        delegate.onFocus?.(item);
        const index = nativeList?._list.getFocus()[0];
        if (index !== undefined) nativeList?._list.reveal(index);
        showPreview?.(item?.action);
      } }, lineAnchor ?? anchor, portal.isConnected ? portal : container, actions);
      // Monaco resets the ContextView width after its first placement. Settle the
      // wider two-pane menu against that final box before the first viewport paint.
      if (hasPreview) service._contextViewService.layout();
    } finally { service._renderWidget = render; }
  };
  controller._actionWidgetService = { show, hide: cancelled => service.hide(cancelled), get isVisible() { return service.isVisible; } };
  const dismissMovedMenu = () => { if (currentView && portal.contains(currentView)) service.hide(true); };
  const resized = editor.onDidLayoutChange(dismissMovedMenu);
  const scrolled = editor.onDidScrollChange(event => { if (event.scrollLeftChanged || event.scrollTopChanged) dismissMovedMenu(); });
  return { dispose() {
    resized.dispose(); scrolled.dispose(); dismissMovedMenu();
    editorNode?.removeAttribute("data-sql-action-open");
    controller._actionWidgetService = service;
  } };
}
