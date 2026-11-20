import { showSqlPreviewCode } from "./sqlPreviewCode";

export type SqlPreviewIcon = `ncforge-join-${string}` | "symbol-field" | "new-file" | "file-code" | "filter" | "history" | "bookmark" | "list-flat" | "git-compare" | "checklist" | "graph" | "references";
export interface SqlPreviewContent {
  text: string;
  note?: string;
  description?: boolean;
  status?: "loading" | "error" | "empty";
  highlights?: readonly { start: number; end: number }[];
}
export type SqlAssistPreview = { title?: string; icon?: SqlPreviewIcon; current?: () => boolean } &
  (SqlPreviewContent | { read: (current: () => boolean) => Promise<SqlPreviewContent>; note?: string });

export function createSqlAssistPreview(doc: Document) {
  const top = doc.createElement("div"), title = doc.createElement("div"), name = doc.createElement("strong"), mode = doc.createElement("span");
  const heading = doc.createElement("div"), panel = doc.createElement("section"), label = doc.createElement("div"), code = doc.createElement("pre");
  const glyph = doc.createElement("span"), labelText = doc.createElement("span");
  const footer = doc.createElement("div");
  top.className = "dbx-sql-action-top";
  title.className = "dbx-sql-action-title";
  heading.className = "dbx-sql-action-preview-heading";
  panel.className = "dbx-sql-action-preview";
  panel.setAttribute("aria-label", "SQL 预览");
  label.className = "dbx-sql-action-preview-label";
  label.setAttribute("role", "status");
  glyph.setAttribute("aria-hidden", "true");
  label.append(glyph, labelText);
  footer.className = "dbx-sql-action-keys";
  title.append(name, mode);
  top.append(title, heading);
  panel.append(label, code);
  for (const [key, text] of [["↑↓", "选择"], ["Enter", "应用"], ["Esc", "关闭"]]) {
    const hint = doc.createElement("span"), cap = doc.createElement("kbd");
    if (key === "Enter") hint.dataset.sqlApply = "";
    cap.textContent = key;
    hint.append(cap, text);
    footer.append(hint);
  }
  let generation = 0;
  function update(preview?: SqlAssistPreview, caption = "SQL 操作", detail = "") {
    const id = ++generation;
    name.textContent = preview?.title ?? caption;
    mode.textContent = detail;
    heading.textContent = "SQL 预览";
    code.scrollTop = code.scrollLeft = 0;
    function show(content: SqlPreviewContent, state: string) {
      panel.dataset.state = state;
      label.hidden = !content.note;
      labelText.textContent = content.note ?? "";
      glyph.hidden = !preview?.icon;
      glyph.className = preview?.icon ? `codicon codicon-${preview.icon}` : "";
      heading.textContent = content.description && state === "ready" ? "操作说明" : "SQL 预览";
      if (content.description || state !== "ready") code.textContent = content.text;
      else showSqlPreviewCode(code, content.text, content.highlights);
    }
    if (!preview) { show({ text: "选择一项即可预览" }, "empty"); return; }
    if (preview.current && !preview.current()) { show({ text: "编辑上下文已变化，请重新打开" }, "error"); return; }
    if ("text" in preview) { show(preview, preview.status ?? "ready"); return; }
    show({ text: "正在准备预览…", note: preview.note }, "loading");
    const current = () => id === generation && panel.isConnected && (!preview.current || preview.current());
    void Promise.resolve().then(() => current() ? preview.read(current) : undefined).then(content => {
      if (current() && content) show(content, "ready");
    }, error => {
      if (current()) show({ text: error instanceof Error ? error.message : "暂时无法预览" }, "error");
    });
  }
  return { top, panel, code, footer, update, clear() { generation++; code.replaceChildren(); } };
}
