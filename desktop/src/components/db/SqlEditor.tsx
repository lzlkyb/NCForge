import { useLayoutEffect, useRef } from "react";
import { initMonaco, monaco } from "../../lib/monacoSetup";
import { sqlModel, tabIdOfModel } from "../../lib/sqlModels";
import { registerSqlProviders } from "../../lib/sqlProviders";
import { pickStatement, splitStatements, type Stmt } from "../../lib/sqlSplit";
import { statementsOf } from "../../lib/sqlStmtCache";
import { applyFormatEdits, fallbackFormatEdits, formatTargetOf, type SqlFormatScope } from "../../lib/sqlFormatTarget";
import { formatSql, sqlLanguageOf } from "../../lib/sqlFormat";
import { connOf, setSqlDraft, sqlTabOf } from "../../lib/dbStore";
import { toast } from "../ui/toast";

export interface RunStmt {
  text: string;
  startLine: number;
  endLine?: number;
  editorVersion?: number;
  editorSql?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface SqlExecutionScope {
  tabId: string;
  selected: boolean;
  statements: RunStmt[];
}

export type { SqlFormatScope };

/** SqlConsole 拿到的编辑器句柄。 */
export interface SqlEditorApi {
  /** `current`：选中的那段（可能多条），没选中就是光标所在的一条；`script`：全部。 */
  insert:(text:string)=>void;
  target: (mode: "current" | "script") => RunStmt[];
  format: (scope?: SqlFormatScope) => void;
  reveal: (line: number) => void;
  focus: () => void;
  setText: (text: string) => void;
}

type Editor = monaco.editor.IStandaloneCodeEditor;

/** 大于这个长度就不再实时高亮当前语句（每次光标移动都要切一遍）。 */
const HL_LIMIT = 200_000;

/**
 * 右键菜单里的分组。用 Monaco 内置的 `navigation`（「转到定义」那一组）而不是自造分组：
 * 自造分组的排序依赖 group id 的字典序，会飘到剪切/粘贴后面去。
 */
const CONTEXT_GROUP = "navigation";
const modelSources = new WeakMap<monaco.editor.ITextModel, { editorVersion: number; editorSql: string }>();

function targetOf(editor: Editor, mode: "current" | "script"): RunStmt[] {
  const model = editor.getModel();
  if (!model) return [];
  const editorVersion = model.getVersionId();
  let source = modelSources.get(model);
  // 范围随光标更新，整篇 SQL 只随版本更新，避免每次移动都重新读取大脚本。
  if (!source || source.editorVersion !== editorVersion) {
    source = { editorVersion, editorSql: model.getValue() };
    modelSources.set(model, source);
  }
  const statement = (stmt: Stmt, offset = 0, lineOffset = 0): RunStmt => ({
    ...source, text: stmt.text, startLine: stmt.startLine + lineOffset, endLine: stmt.endLine + lineOffset,
    startOffset: stmt.start + offset, endOffset: stmt.end + offset,
  });
  const sel = editor.getSelection();
  if (mode === "current" && sel && !sel.isEmpty()) {
    const part = model.getValueInRange(sel);
    const offset = model.getOffsetAt(sel.getStartPosition());
    return splitStatements(part).map((s) => statement(s, offset, sel.startLineNumber - 1));
  }
  if (mode === "script") return statementsOf(model).map((s) => statement(s));
  const pos = editor.getPosition();
  const s = pos ? pickStatement(statementsOf(model), model.getOffsetAt(pos)) : null;
  return s ? [statement(s)] : [];
}

/** 按范围格式化（范围解析见 lib/sqlFormatTarget）。整篇解析失败时逐条兜底，坏语句保留原文。 */
async function formatAt(editor: Editor, scope: SqlFormatScope = "auto") {
  const model = editor.getModel();
  if (!model) return;
  const target = formatTargetOf(model, editor.getSelection(), editor.getPosition(), scope);
  if (!target) {
    toast("光标处没有可格式化的 SQL 语句", "warning");
    return;
  }
  const connId = sqlTabOf(tabIdOfModel(model))?.connId;
  const language = sqlLanguageOf(connId ? connOf(connId)?.url ?? "" : "");
  const version = model.getVersionId();
  const stale = () => editor.getModel() !== model || model.getVersionId() !== version;
  let text: string | null = null;
  let error = "";
  try { text = await formatSql(target.text, language); }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  if (stale()) return;
  if (text !== null) { applyFormatEdits(editor, [{ range: target.range, text }]); return; }
  if (target.kind !== "script") { toast(`SQL 格式化失败：${error}`, "warning"); return; }
  // 整个脚本里有一条没写完（引号/括号未闭合）会整篇解析失败：逐条排版，只跳过那一条。
  const result = await fallbackFormatEdits(model, target.text, language);
  if (stale()) return;
  if (result.edits.length === 0) { toast(`SQL 格式化失败：${result.error ?? error}`, "warning"); return; }
  applyFormatEdits(editor, result.edits);
  if (result.skipped > 0) toast(`已格式化 ${result.edits.length} 条语句，跳过 ${result.skipped} 条无法解析的`, "warning");
}

/**
 * SQL 编辑器（Monaco，与源码编辑器同一套）。整个控制台只有一个实例，切标签 = 换 model。
 * Ctrl+Enter 执行当前语句 / Alt+X 执行脚本 / Ctrl+Shift+F 格式化；光标所在语句浅色高亮。
 * 这三条同时挂在编辑器右键菜单里（`addAction`），所以工具条的主按钮上不再印键位。
 * Ctrl+点击表名打开它的 DDL——链接由 `lib/sqlProviders.ts` 里的 LinkProvider 挂上。
 */
export function SqlEditor({ tabId, initial, onRun, apiRef, onScope, visible = true }: {
  tabId: string;
  initial: string;
  onRun: (mode: "current" | "script") => void;
  apiRef: { current: SqlEditorApi | null };
  onScope?: (scope: SqlExecutionScope) => void;
  visible?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const refreshScope = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const previousVisible = useRef(visible);
  const onScopeRef=useRef(onScope);onScopeRef.current=onScope;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    initMonaco();
    registerSqlProviders();
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 20,
      ariaLabel: "SQL 查询编辑器",
      padding: { top: 8, bottom: 8 },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      wordBasedSuggestions: "off",
      suggest: { showWords: false },
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    // 用 addAction 而不是 addCommand：前者能带 label 进编辑器右键菜单（键位由 Monaco 自动渲染在
    // 菜单项右侧），工具条按钮上就不必再印 Ctrl+Enter。id 会同时出现在 F1 命令面板里。
    editor.addAction({
      id: "ncforge.sql.runCurrent",
      label: "执行当前语句",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: CONTEXT_GROUP,
      contextMenuOrder: 0.1,
      run: () => onRunRef.current("current"),
    });
    editor.addAction({
      id: "ncforge.sql.runScript",
      label: "执行整个脚本",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyX],
      contextMenuGroupId: CONTEXT_GROUP,
      contextMenuOrder: 0.2,
      run: () => onRunRef.current("script"),
    });
    editor.addAction({
      id: "ncforge.sql.format",
      label: "格式化 SQL",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
      contextMenuGroupId: CONTEXT_GROUP,
      contextMenuOrder: 0.3,
      run: () => formatAt(editor),
    });

    const target = (mode: "current" | "script") => targetOf(editor, mode);
    const rememberView = () => {
      const model = editor.getModel(), view = editor.saveViewState();
      const id = model && tabIdOfModel(model);
      if (id && view) views.current.set(id, view);
    };
    const deco = editor.createDecorationsCollection();
    let raf = 0;
    let previousScope: SqlExecutionScope | null = null;
    const highlight = () => {
      const model = editor.getModel(), id = model && tabIdOfModel(model);
      // 与按钮/快捷键最终调用的 target() 共用语句列表，范围不能另行猜测或切分。
      if (id) {
        const next = { tabId: id, selected: editor.getSelection()?.isEmpty() === false, statements: target("current") };
        // 语句内移动光标不必让整块结果网格跟随重绘。
        if (!previousScope || previousScope.tabId !== id || previousScope.selected !== next.selected || previousScope.statements.length !== next.statements.length
          || next.statements.some((stmt, index) => { const previous = previousScope!.statements[index]; return stmt.text !== previous.text || stmt.startLine !== previous.startLine || stmt.endLine !== previous.endLine; })) {
          previousScope = next;
          onScopeRef.current?.(next);
        }
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos || model.getValueLength() > HL_LIMIT) return deco.clear();
        // 切分结果按 model 版本缓存：光标移动不重切，内容变了才切一遍
        const all = statementsOf(model);
        const s = pickStatement(all, model.getOffsetAt(pos));
        // 只有一条语句时不高亮：整篇都是它，高亮反而是噪音
        if (!s || all.length < 2) return deco.clear();
        deco.set([{
          range: new monaco.Range(s.startLine, 1, s.endLine, 1),
          options: { isWholeLine: true, className: "dbx-stmt-hl", linesDecorationsClassName: "dbx-stmt-gl" },
        }]);
      });
    };
    refreshScope.current = highlight;
    const subs = [
      editor.onDidChangeCursorPosition(highlight),
      editor.onDidChangeCursorSelection(highlight),
      editor.onDidChangeModelContent(() => {
        const model = editor.getModel();
        const id = model && tabIdOfModel(model);
        if (model && id) setSqlDraft(id, model.getValue());
        if (!visibleRef.current) rememberView();
        highlight();
      }),
    ];
    apiRef.current = {
      insert:(text)=>{const range=editor.getSelection();if(range) editor.executeEdits("ncforge-object-name",[{range,text,forceMoveMarkers:true}]);if (visibleRef.current) editor.focus();},
      target,
      format: (scope) => formatAt(editor, scope),
      reveal: (line) => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        rememberView();
        if (visibleRef.current) editor.focus();
      },
      focus: () => { if (visibleRef.current) editor.focus(); },
      setText: (text) => {
        const model = editor.getModel();
        if (!model) return;
        editor.executeEdits("ncforge-history", [{ range: model.getFullModelRange(), text }]);
        if (visibleRef.current) editor.focus();
      },
    };
    return () => {
      cancelAnimationFrame(raf);
      subs.forEach((d) => d.dispose());
      apiRef.current = null;
      refreshScope.current = null;
      editor.dispose();
      editorRef.current = null;
    };
  }, [apiRef]);

  // Monaco 的 model 保存草稿/撤销栈，光标、选区与滚动须按文档单独保存。
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = editor.getModel(), previousView = editor.saveViewState();
    const previousId = previous && tabIdOfModel(previous);
    if (previousId && previousView && previousVisible.current) views.current.set(previousId, previousView);
    editor.setModel(sqlModel(tabId, initial));
    const view = views.current.get(tabId);
    if (view) editor.restoreViewState(view);
    if (visibleRef.current) { editor.layout(); editor.focus(); }
    refreshScope.current?.();
    // initial 只在第一次建 model 时有用，之后以 model 为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useLayoutEffect(() => {
    const editor = editorRef.current, model = editor?.getModel();
    const id = model && tabIdOfModel(model);
    previousVisible.current = visible;
    if (!editor || !id) return;
    if (!visible) {
      const view = editor.saveViewState();
      if (view) views.current.set(id, view);
    } else {
      editor.layout();
      const view = views.current.get(id);
      if (view) editor.restoreViewState(view);
      editor.focus();
    }
    refreshScope.current?.();
  }, [visible]);

  return (
    <div className="dbx-editor" hidden={!visible}>
      <div ref={hostRef} className="wb-editor-host" />
    </div>
  );
}
