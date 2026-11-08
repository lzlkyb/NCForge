import { useEffect, useRef, useState } from "react";
import { initMonaco, monaco } from "../../lib/monacoSetup";
import { javaSuggestOptions } from "../../lib/javaSuggestOptions";
import { bindEditorCommand } from "../../lib/editorCommandBinding";
import { getModel, touchModel, onModelLifecycle } from "../../lib/editorStore";
import { readGroupView, storeGroupView } from "../../lib/editorGroupViews";
import type { EditorGroupId } from "../../lib/editorGroups";
import { registerLangProviders } from "../../lib/langProviders";
import { registerExtraLangProviders } from "../../lib/langProvidersExtra";
import { registerEditorKeys, releaseCurrentEditor, setCurrentEditor } from "../../lib/editorActions";
import { editorCommand, getKeymap, isTypeHierarchyKey } from "../../lib/keymap";
import { registerJavaSqlActions } from "../../lib/javaSqlActions";
import { registerJavaTemplates } from "../../lib/liveTemplates";
import { organizeImportsCommand } from "../../lib/javaActions";
import { registerRefactorKeys } from "../../lib/refactor";
import { runCallHierarchy } from "../../lib/callHierarchy";
import { runTypeHierarchy } from "../../lib/typeHierarchy";
import { attachErrorLens } from "../../lib/errorLens";
import { attachBookmarkGutter } from "../../lib/bookmarkGutter";
import { attachDebugGutter } from "../../lib/debugGutter";
import { wireDebugHover } from "../../lib/debugHover";
import { toggleBreakpointHere } from "../../lib/debugSession";
import { registerDebugEditorKeys } from "../../lib/debugEditorKeys";
import { getEditorPrefs, monacoOptionsOf, PREFS_EVENT } from "../../lib/editorPrefs";
import { attachJavaStickyScope } from "../../lib/javaStickyScope";
import { formatBeforeSave } from "../../lib/formatOnSave";
import { noteEdit, previousEditSpot } from "../../lib/editHistory";
import { pathOfModel } from "../../lib/editorStore";
import { toggleBookmark } from "../../lib/bookmarks";
import { setSession } from "../../lib/workspaceSession";
import { toast } from "../ui/toast";
import { navigate } from "../../lib/lang";
import "../../error-lens.css";
import "../../bookmark-gutter.css";
import "../../debug.css";

interface Props {
  groupId?: EditorGroupId;
  focused?: boolean;
  onFocus?: () => void;
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
  onSave: (prepare?: () => Promise<void | "failed">) => void;
}

type Editor = ReturnType<typeof monaco.editor.create>;

/**
 * Monaco 编辑器。整个组件只创建一个编辑器实例，切换标签页 = 换 model（见 lib/editorStore），
 * 光标、滚动位置、撤销栈都随 model 保留。
 */
export function EditorPane({ activePath, readOnly, reveal, heavy, onCursor, onSave, groupId, focused = true, onFocus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const shownRef = useRef<string | null>(null);
  // 回调用 ref 保存最新值：Monaco 的快捷键/事件在创建时注册一次，不能每次渲染重新注册。
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursor);
  onSaveRef.current = onSave;
  onCursorRef.current = onCursor;
  const focusRef = useRef({ focused, onFocus, groupId }); focusRef.current = { focused, onFocus, groupId };

  // 创建一次
  useEffect(() => {
    if (!hostRef.current) return;
    initMonaco();
    registerLangProviders();
    // 引用 / 格式化 / 快速修复 / 跳实现：与上面四个 provider 同一根管道，
    // 只是这些能力 Monaco 的右键菜单和命令面板会自动接上去，不用自己造 UI
    registerExtraLangProviders();
    // 代码模板（sout / fori / ifn…）：纯编辑器能力，不依赖语言服务是否就绪
    registerJavaTemplates();
    // 调试悬停：只在暂停时求值，其余时间不接管悬停
    wireDebugHover();
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: true,
      // 字号 / 字体 / 换行 / 缩进 / 小地图 / 粘性滚动来自设置页（lib/editorPrefs），
      // 这里给一份默认值，紧接着 updateOptions 覆盖成用户偏好
      ...monacoOptionsOf(getEditorPrefs()),
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: "line",
      "semanticHighlighting.enabled": true,
      // 行号左边留一格（行高宽）给书签小旗。ESM 版 Monaco 把默认值改成了 false
      // （editor.api.js 里 `EditorOptions.glyphMargin.defaultValue = false`），不显式打开就没有这条槽。
      glyphMargin: true,
      // 中文全角标点会被当成「易混淆字符」满屏框高亮，NC 源码里到处是中文注释，关掉。
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      // 没有语言服务时只给当前文档的单词补全，避免弹出一堆无关建议。
      ...javaSuggestOptions,
    });
    // Ctrl+S 与自动保存共用：先按偏好格式化，再落盘
    const saveNow = () => onSaveRef.current(() => formatBeforeSave(editor));
    const bind = (key: number, run: () => void, label: string) => bindEditorCommand(editor, key, run, label);
    bind(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveNow(), "保存当前文件");
    // Ctrl+Alt+O = 组织导入（IDEA 同键）。走命令而不是 provider：
    // 它是一次性的整文件动作，不是「编辑器要显示什么」。
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyO,
      () => void organizeImportsCommand(),
      "组织导入",
    );
    // Ctrl+Alt+H = 调用层级（IDEA 同键）。结果落在底部面板的「调用层级」标签。
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH,
      () => void runCallHierarchy(),
      "调用层级",
    );
    // 提取类重构（IDEA 同键：Ctrl+Alt+M/V/F/C）。键位与命令面板共用 lib/refactor 里的清单
    registerRefactorKeys(editor);
    // F11 = 加/去书签（IDEA 同键）；Shift+F11 = 打开书签面板
    bind(monaco.KeyCode.F11, () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return;
      const path = pathOfModel(model);
      if (!path) {
        toast("jar 内的类不能加书签", "info");
        return;
      }
      const r = toggleBookmark(path, pos.lineNumber, model.getLineContent(pos.lineNumber));
      toast(r === "added" ? `已加书签（第 ${pos.lineNumber} 行）` : "已移除书签", "success");
    }, "切换当前行书签");
    bind(monaco.KeyMod.Shift | monaco.KeyCode.F11, () => setSession({ panelOpen: true, panelTab: "bookmarks" }), "查看书签");
    // Ctrl+F8 = 当前行加/去断点（IDEA 同键）。与书签 F11 互不挤占。
    bind(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8, () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return;
      const path = pathOfModel(model);
      if (!path) {
        toast("jar 内的类不能加断点", "info");
        return;
      }
      const r = toggleBreakpointHere(path, pos.lineNumber);
      toast(r === "added" ? `已加断点（第 ${pos.lineNumber} 行）` : "已移除断点", "success");
    }, "切换当前行断点");
    // 调试步进键：F5–F9 的含义由当前 keymap 决定（见 lib/debugKeys）
    registerDebugEditorKeys(editor);
    // Ctrl+Shift+Backspace = 回到上一个编辑位置（与「后退」不同：它记的是打字，不是跳转）
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Backspace,
      () => {
        const pos = editor.getPosition();
        const path = editor.getModel() ? pathOfModel(editor.getModel()!) : undefined;
        const spot = previousEditSpot(path && pos ? { path, line: pos.lineNumber } : null);
        if (!spot) {
          toast("没有更早的编辑位置了", "info");
          return;
        }
        navigate({ kind: "file", path: spot.path, line: spot.line, column: 1 });
      },
      "返回上一个编辑位置",
    );
    const keyboard = editor.onKeyDown(event => {
      if (!editor.hasTextFocus()) return;
      const keymap = getKeymap();
      // 类型层级：两套方案各占一个键。不匹配的键原样放行——Eclipse 下 Ctrl+H 是全工程搜索，
      // 由 App 的 window 监听处理，这里拦住就搜不到了。
      if (isTypeHierarchyKey(event.browserEvent, keymap)) {
        event.preventDefault();
        event.stopPropagation();
        void runTypeHierarchy();
        return;
      }
      const action = editorCommand(event.browserEvent, keymap);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      editor.trigger("ncforge-keymap", action, undefined);
    });
    editor.onDidChangeCursorPosition((e) => onCursorRef.current(e.position.lineNumber, e.position.column));
    // 记录编辑位置（Ctrl+Shift+Backspace 用）+ 自动保存（可关，默认关）。
    // 两件事都在内容变化时触发，合并一个订阅：拆成两个会让每次按键多一次回调。
    let autoSaveTimer: number | undefined;
    const contentSub = editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (!model) return;
      const path = pathOfModel(model);
      const pos = editor.getPosition();
      if (path && pos) noteEdit(path, pos.lineNumber);
      const prefs = getEditorPrefs();
      if (!prefs.autoSave || !focusRef.current.focused) return;
      if (autoSaveTimer !== undefined) window.clearTimeout(autoSaveTimer);
      autoSaveTimer = window.setTimeout(() => {
        // 触发时再读一次：这期间用户可能刚关掉开关
        if (getEditorPrefs().autoSave && focusRef.current.focused && editor.getModel() === model) void saveNow();
      }, Math.max(500, prefs.autoSaveDelayMs));
    });
    const sqlActions = registerJavaSqlActions(editor);
    // 行尾诊断（Error Lens）：数据来自 diagStore，开关在设置 → 编辑器
    const lensOff = attachErrorLens(editor);
    // 行号槽书签：数据来自 lib/bookmarks（F11 增删、书签面板共用同一份）
    const bookmarkOff = attachBookmarkGutter(editor);
    // 行号槽断点 + 暂停行：数据来自 lib/breakpoints 与 lib/debugSession
    const debugOff = attachDebugGutter(editor);
    // Alt+Enter 绑快速修复；命令面板要靠这个引用找到「当前在编辑哪个文件」
    registerEditorKeys(editor);
    if (focusRef.current.focused) setCurrentEditor(editor);
    // 分屏时有两个编辑器：命令面板 / F2 / 快速修复必须跟着焦点走。
    const focusSub = editor.onDidFocusEditorText(() => { focusRef.current.onFocus?.(); setCurrentEditor(editor); const pos = editor.getPosition(); if (pos) onCursorRef.current(pos.lineNumber, pos.column); });
    editorRef.current = editor;
    return () => {
      sqlActions.forEach((d) => d.dispose());
      lensOff();
      bookmarkOff();
      debugOff();
      contentSub.dispose();
      if (autoSaveTimer !== undefined) window.clearTimeout(autoSaveTimer);
      focusSub.dispose();
      releaseCurrentEditor(editor);
      // 注意只销毁编辑器实例，model 留在 editorStore（切到别的页签再回来还在）。
      if (shownRef.current) storeGroupView(focusRef.current.groupId, shownRef.current, editor.saveViewState());
      keyboard.dispose();
      editor.dispose();
      editorRef.current = null;
      shownRef.current = null;
    };
  }, []);

  const [modelGeneration, setModelGeneration] = useState(0);
  useEffect(() => onModelLifecycle(
    path => { if (path === activePath) setModelGeneration(value => value + 1); },
    path => { if (path === activePath) setModelGeneration(value => value + 1); },
  ), [activePath]);

  // 切换文件
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (shownRef.current && shownRef.current !== activePath) {
      storeGroupView(focusRef.current.groupId, shownRef.current, editor.saveViewState());
    }
    const model = activePath ? getModel(activePath) : undefined;
    editor.setModel(model ?? null);
    shownRef.current = model ? activePath : null;
    if (model && activePath) {
      // 预览身份（peek 队列里）的模型被显示时保活：转正路径已摘牌，这里是二道网，
      // 免得正在看的这个正好是下一个被淘汰的
      touchModel(activePath);
      const vs = readGroupView(focusRef.current.groupId, activePath);
      if (vs) editor.restoreViewState(vs);
      // 恢复视图不会触发 onDidChangeCursorPosition，切页回来时状态栏会停在「第 1 行」。
      // 这里主动把恢复后的位置报上去。
      const pos = editor.getPosition();
      if (pos && focusRef.current.focused) onCursorRef.current(pos.lineNumber, pos.column);
      if (focusRef.current.focused) editor.focus();
    }
  }, [activePath, modelGeneration]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!focused || !editor) return;
    setCurrentEditor(editor);
    const pos = editor.getPosition(); if (pos) onCursorRef.current(pos.lineNumber, pos.column);
  }, [focused, activePath]);

  // 只读状态随标签变化
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, activePath]);

  // 设置变化与大文件降级共用一次计算，切换文件时保留用户的小地图偏好。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const java = editor.getModel()?.getLanguageId() === "java";
    const apply = () => editor.updateOptions(monacoOptionsOf(getEditorPrefs(), heavy, java));
    apply();
    const detach = java && activePath && !heavy ? attachJavaStickyScope(editor, activePath) : undefined;
    window.addEventListener(PREFS_EVENT, apply);
    return () => { window.removeEventListener(PREFS_EVENT, apply); detach?.(); };
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

  return <div ref={hostRef} className="wb-editor-host" />;
}
