import { useEffect, useRef } from "react";
import { initMonaco, monaco } from "../../lib/monacoSetup";
import { sqlModel, tabIdOfModel } from "../../lib/sqlModels";
import { registerSqlProviders } from "../../lib/sqlProviders";
import { isPlsql, splitStatements, statementAt } from "../../lib/sqlSplit";
import { formatSql } from "../../lib/sqlFormat";
import { setSqlDraft } from "../../lib/dbStore";

export interface RunStmt {
  text: string;
  startLine: number;
}

/** SqlConsole 拿到的编辑器句柄。 */
export interface SqlEditorApi {
  /** `current`：选中的那段（可能多条），没选中就是光标所在的一条；`script`：全部。 */
  target: (mode: "current" | "script") => RunStmt[];
  format: () => void;
  reveal: (line: number) => void;
  focus: () => void;
  setText: (text: string) => void;
}

type Editor = monaco.editor.IStandaloneCodeEditor;

/** 大于这个长度就不再实时高亮当前语句（每次光标移动都要切一遍）。 */
const HL_LIMIT = 200_000;

function targetOf(editor: Editor, mode: "current" | "script"): RunStmt[] {
  const model = editor.getModel();
  if (!model) return [];
  const text = model.getValue();
  const sel = editor.getSelection();
  if (mode === "current" && sel && !sel.isEmpty()) {
    const part = model.getValueInRange(sel);
    return splitStatements(part).map((s) => ({ text: s.text, startLine: sel.startLineNumber + s.startLine - 1 }));
  }
  if (mode === "script") return splitStatements(text).map((s) => ({ text: s.text, startLine: s.startLine }));
  const pos = editor.getPosition();
  const s = pos ? statementAt(text, model.getOffsetAt(pos)) : null;
  return s ? [{ text: s.text, startLine: s.startLine }] : [];
}

/** 格式化选中部分，或光标所在的语句；PL/SQL 块不动。走 executeEdits 保留撤销。 */
function formatAt(editor: Editor) {
  const model = editor.getModel();
  if (!model) return;
  const sel = editor.getSelection();
  let range: monaco.IRange;
  let src: string;
  if (sel && !sel.isEmpty()) {
    range = sel;
    src = model.getValueInRange(sel);
  } else {
    const pos = editor.getPosition();
    const s = pos ? statementAt(model.getValue(), model.getOffsetAt(pos)) : null;
    if (!s) return;
    const a = model.getPositionAt(s.start);
    const b = model.getPositionAt(s.start + s.text.length);
    range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    src = s.text;
  }
  if (isPlsql(src)) return;
  editor.executeEdits("ncforge-format", [{ range, text: formatSql(src) }]);
}

/**
 * SQL 编辑器（Monaco，与源码编辑器同一套）。整个控制台只有一个实例，切标签 = 换 model。
 * Ctrl+Enter 执行当前语句 / Alt+X 执行脚本 / Ctrl+Shift+F 格式化；光标所在语句浅色高亮。
 */
export function SqlEditor({ tabId, initial, onRun, apiRef }: {
  tabId: string;
  initial: string;
  onRun: (mode: "current" | "script") => void;
  apiRef: { current: SqlEditorApi | null };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    if (!hostRef.current) return;
    initMonaco();
    registerSqlProviders();
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      wordBasedSuggestions: "off",
      suggest: { showWords: false },
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current("current"));
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyX, () => onRunRef.current("script"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => formatAt(editor));

    const deco = editor.createDecorationsCollection();
    let raf = 0;
    const highlight = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos || model.getValueLength() > HL_LIMIT) return deco.clear();
        const text = model.getValue();
        const s = statementAt(text, model.getOffsetAt(pos));
        // 只有一条语句时不高亮：整篇都是它，高亮反而是噪音
        if (!s || splitStatements(text).length < 2) return deco.clear();
        deco.set([{
          range: new monaco.Range(s.startLine, 1, s.endLine, 1),
          options: { isWholeLine: true, className: "dbx-stmt-hl", linesDecorationsClassName: "dbx-stmt-gl" },
        }]);
      });
    };
    const subs = [
      editor.onDidChangeCursorPosition(highlight),
      editor.onDidChangeModelContent(() => {
        const model = editor.getModel();
        const id = model && tabIdOfModel(model);
        if (model && id) setSqlDraft(id, model.getValue());
        highlight();
      }),
    ];
    apiRef.current = {
      target: (mode) => targetOf(editor, mode),
      format: () => formatAt(editor),
      reveal: (line) => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      },
      focus: () => editor.focus(),
      setText: (text) => {
        const model = editor.getModel();
        if (!model) return;
        editor.executeEdits("ncforge-history", [{ range: model.getFullModelRange(), text }]);
        editor.focus();
      },
    };
    return () => {
      cancelAnimationFrame(raf);
      subs.forEach((d) => d.dispose());
      apiRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
  }, [apiRef]);

  // 切标签：换 model（撤销栈与光标都跟着 model 走）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setModel(sqlModel(tabId, initial));
    editor.focus();
    // initial 只在第一次建 model 时有用，之后以 model 为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return (
    <div className="dbx-editor">
      <div ref={hostRef} className="wb-editor-host" />
    </div>
  );
}
