import { useLayoutEffect, useRef } from "react";
import { initMonaco, monaco } from "../../lib/monacoSetup";
import { sqlModel, tabIdOfModel } from "../../lib/sqlModels";
import { registerSqlProviders } from "../../lib/sqlProviders";
import { wireSqlEditorAssist } from "../../lib/sqlEditorAssist";
import { wireSqlSuggestLayout } from "../../lib/sqlSuggestLayout";
import { wireSqlActionMenu } from "../../lib/sqlActionMenu";
import { pickStatement } from "../../lib/sqlSplit";
import { statementsOf } from "../../lib/sqlStmtCache";
import type { SqlFormatScope } from "../../lib/sqlFormatTarget";
import { formatAt, targetOf, type RunStmt, type SqlExecutionScope, type SqlRunMode } from "../../lib/sqlEditorTarget";
import { setSqlDraft } from "../../lib/dbStore";
import { useSqlEditorDialect } from "../../hooks/useSqlEditorDialect";
import { useSqlDisplayPrefs } from "../../hooks/useSqlDisplayPrefs";
import { codeDisplayOptionsOf, getEditorPrefs } from "../../lib/editorPrefs";

// 取执行范围 / 格式化的逻辑在 lib/sqlEditorTarget；类型从这里转出，调用方不用改引用。
export type { RunStmt, SqlExecutionScope, SqlFormatScope, SqlRunMode };
/** SqlConsole 拿到的编辑器句柄。 */
export interface SqlEditorApi {
  /** auto：选中内容或全部；current：仅光标语句；script：全部。 */
  insert:(text:string)=>void;
  target: (mode: SqlRunMode) => RunStmt[];
  format: (scope?: SqlFormatScope) => void;
  reveal: (line: number) => void;
  focus: () => void;
  setText: (text: string) => void;
  fix?: (target: { editorSql: string; start: number; end: number; text: string }) => boolean;
}

type Editor = monaco.editor.IStandaloneCodeEditor;

/** 大于这个长度就不再实时高亮当前语句（每次光标移动都要切一遍）。 */
const HL_LIMIT = 200_000;

/**
 * 右键菜单里的分组。用 Monaco 内置的 `navigation`（「转到定义」那一组）而不是自造分组：
 * 自造分组的排序依赖 group id 的字典序，会飘到剪切/粘贴后面去。
 */
const CONTEXT_GROUP = "navigation";

/**
 * SQL 编辑器（Monaco，与源码编辑器同一套）。整个控制台只有一个实例，切标签 = 换 model。
 * Ctrl+Enter 执行当前语句 / Alt+X 执行脚本 / Ctrl+Shift+F 格式化；光标所在语句浅色高亮。
 * 这三条同时挂在编辑器右键菜单里（`addAction`），所以工具条的主按钮上不再印键位。
 * Ctrl+点击表名打开它的 DDL——链接由 `lib/sqlProviders.ts` 里的 LinkProvider 挂上。
 */
export function SqlEditor({ tabId, initial, onRun, apiRef, onScope, visible = true }: {
  tabId: string;
  initial: string;
  onRun: (mode: SqlRunMode) => void;
  apiRef: { current: SqlEditorApi | null };
  onScope?: (scope: SqlExecutionScope) => void;
  visible?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement | null>(null);
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
    // The workbench clips its document area. Monaco positions these popups in viewport coordinates.
    const doc = hostRef.current.ownerDocument;
    const overflow = doc.createElement("div");
    overflow.className = "monaco-editor dbx-sql-overflow";
    overflow.hidden = !visibleRef.current;
    doc.body.append(overflow);
    overflowRef.current = overflow;
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: true,
      ...codeDisplayOptionsOf(getEditorPrefs()),
      ariaLabel: "SQL 查询编辑器",
      padding: { top: 8, bottom: 8 },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      wordBasedSuggestions: "off",
      "semanticHighlighting.enabled": true,
      suggest: { showWords: false },
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflow,
    });
    editorRef.current = editor;
    // 用 addAction 而不是 addCommand：前者能带 label 进编辑器右键菜单（键位由 Monaco 自动渲染在
    // 菜单项右侧），工具条按钮上就不必再印 Ctrl+Enter。id 会同时出现在 F1 命令面板里。
    editor.addAction({
      id: "ncforge.sql.run",
      label: "执行选中 SQL 或当前语句",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: CONTEXT_GROUP,
      contextMenuOrder: 0.1,
      run: () => onRunRef.current("auto"),
    });
    editor.addAction({ id: "ncforge.sql.runCurrent", label: "执行当前语句",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], contextMenuGroupId: CONTEXT_GROUP,
      contextMenuOrder: 0.15, run: () => onRunRef.current("current") });
    editor.addAction({ id: "ncforge.sql.runScript",
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

    const target = (mode: SqlRunMode) => targetOf(editor, mode);
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
        const next = { tabId: id, selected: editor.getSelection()?.isEmpty() === false, statements: target("auto") };
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
    const subs = [wireSqlEditorAssist(editor), wireSqlSuggestLayout(editor), wireSqlActionMenu(editor, overflow),
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
      fix: ({ editorSql, start, end, text }) => {
        const model = editor.getModel();
        if (!model || model.getValue() !== editorSql) return false;
        const from = model.getPositionAt(start), to = model.getPositionAt(end);
        const range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
        editor.pushUndoStop();
        editor.executeEdits("ncforge-sql-fix", [{ range, text }]);
        editor.pushUndoStop();
        editor.revealLineInCenter(range.startLineNumber);
        if (visibleRef.current) editor.focus();
        return true;
      },
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
      overflow.remove();
      overflowRef.current = null;
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
    if (overflowRef.current) overflowRef.current.hidden = !visible;
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

  useSqlEditorDialect(editorRef, tabId);
  useSqlDisplayPrefs(editorRef);
  return (
    <div className="dbx-editor" hidden={!visible}>
      <div ref={hostRef} className="wb-editor-host" />
    </div>
  );
}
