import { useEffect, useRef } from "react";
import { initMonaco, monaco } from "../../lib/monacoSetup";
import { getModel, getViewState, saveViewState } from "../../lib/editorStore";
import { registerLangProviders } from "../../lib/langProviders";
import { editorCommand, getKeymap } from "../../lib/keymap";
import { registerJavaSqlActions } from "../../lib/javaSqlActions";
import { ExtractSqlDialog } from "../db/ExtractSqlDialog";

interface Props {
  /** 当前显示的文件；null = 没有打开的文件。 */
  activePath: string | null;
  readOnly: boolean;
  /**
   * 跳转到指定位置（点问题列表、搜索命中用）。`nonce` 每次请求都换一个新值，
   * 这样连点同一行的两条问题也能重新定位；为 null 表示不跳。
   */
  reveal?: { line: number; column?: number; nonce: number } | null;
  /**
   * 超大文件：关掉几项「每次输入都要全文件重算」的功能。
   * NC 二开里几千行的 BO/BP 很常见，这些计算会让打字明显掉帧。
   */
  heavy: boolean;
  onCursor: (line: number, column: number) => void;
  onSave: () => void;
}

type Editor = ReturnType<typeof monaco.editor.create>;

/**
 * Monaco 编辑器。整个组件只创建一个编辑器实例，切换标签页 = 换 model（见 lib/editorStore），
 * 光标、滚动位置、撤销栈都随 model 保留。
 */
export function EditorPane({ activePath, readOnly, reveal, heavy, onCursor, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const shownRef = useRef<string | null>(null);
  // 回调用 ref 保存最新值：Monaco 的快捷键/事件在创建时注册一次，不能每次渲染重新注册。
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursor);
  onSaveRef.current = onSave;
  onCursorRef.current = onCursor;

  // 创建一次
  useEffect(() => {
    if (!hostRef.current) return;
    initMonaco();
    registerLangProviders();
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, showSlider: "mouseover" },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: "line",
      // 中文全角标点会被当成「易混淆字符」满屏框高亮，NC 源码里到处是中文注释，关掉。
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      // 没有语言服务时只给当前文档的单词补全，避免弹出一堆无关建议。
      wordBasedSuggestions: "currentDocument",
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    const keyboard = editor.onKeyDown(event => {
      if (!editor.hasTextFocus()) return;
      const action = editorCommand(event.browserEvent, getKeymap());
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      editor.trigger("ncforge-keymap", action, undefined);
    });
    editor.onDidChangeCursorPosition((e) => onCursorRef.current(e.position.lineNumber, e.position.column));
    const sqlActions = registerJavaSqlActions(editor);
    editorRef.current = editor;
    return () => {
      sqlActions.forEach((d) => d.dispose());
      // 注意只销毁编辑器实例，model 留在 editorStore（切到别的页签再回来还在）。
      if (shownRef.current) saveViewState(shownRef.current, editor.saveViewState());
      keyboard.dispose();
      editor.dispose();
      editorRef.current = null;
      shownRef.current = null;
    };
  }, []);

  // 切换文件
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (shownRef.current && shownRef.current !== activePath) {
      saveViewState(shownRef.current, editor.saveViewState());
    }
    const model = activePath ? getModel(activePath) : undefined;
    editor.setModel(model ?? null);
    shownRef.current = model ? activePath : null;
    if (model && activePath) {
      const vs = getViewState(activePath);
      if (vs) editor.restoreViewState(vs);
      // 恢复视图不会触发 onDidChangeCursorPosition，切页回来时状态栏会停在「第 1 行」。
      // 这里主动把恢复后的位置报上去。
      const pos = editor.getPosition();
      if (pos) onCursorRef.current(pos.lineNumber, pos.column);
      editor.focus();
    }
  }, [activePath]);

  // 只读状态随标签变化
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, activePath]);

  // 超大文件降级。括号对着色要逐行配对、折叠要算整个文档的区间、小地图要渲染缩略，
  // 这三样在几千行的 BO/BP 上每次输入都要重算，打字会明显掉帧。切回小文件时再打开。
  useEffect(() => {
    editorRef.current?.updateOptions({
      bracketPairColorization: { enabled: !heavy },
      folding: !heavy,
      minimap: { enabled: !heavy, showSlider: "mouseover" },
    });
  }, [heavy, activePath]);

  // 跳转到指定行。必须排在上面的「切换文件」之后：同一个 commit 里 effect 按声明顺序执行，
  // 先换 model 再定位，否则 setPosition 会落到上一个文件的 model 上被 setModel 冲掉。
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !reveal) return;
    // 行号来自编译产物/搜索结果，理论上不会越界；仍然夹一下，避免插件里的畸形值抛错。
    const line = Math.min(Math.max(1, reveal.line), model.getLineCount());
    // 列号只有搜索命中会给（那才知道是行里的哪个位置）；编译问题只到行，
    // 落在行首是对的——错误列在 ecj 输出里不够可靠。
    const maxCol = model.getLineMaxColumn(line);
    const column = Math.min(Math.max(1, reveal.column ?? 1), maxCol);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  }, [reveal]);

  return (
    <>
      <div ref={hostRef} className="wb-editor-host" />
      <ExtractSqlDialog />
    </>
  );
}
