// 编辑器动作的中文入口。
//
// 为什么不做一套自己的右键菜单：Monaco 在注册了 reference / codeAction / formatting provider 之后
// 会自动往右键里加项（Go to References、Quick Fix、Format Document……），再 addAction 一遍
// 就是「右键里中英各一条」，比没有更烦人。
//
// 所以这里的定位是**补两件 Monaco 给不了的事**：
// 1. 命令面板里的中文条目 —— 用户记不住快捷键时唯一的出路是「敲中文找」；
// 2. `Alt+Enter` —— 从 IDEA 迁过来的人就是这个键，Monaco 内置是 Ctrl+. 。
import { monaco } from "./monacoSetup";
import { pathOfModel } from "./editorStore";

/**
 * 当前编辑器。
 *
 * 不用 `monaco.editor.getEditors()` 猜：编辑器实例在 `EditorPane` 里创建，注册时把引用存下来
 * 最省事；`getEditors()` 只在卸载竞态（引用已清但实例还在）时兜底。
 */
let current: monaco.editor.IStandaloneCodeEditor | null = null;

export function setCurrentEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  current = editor;
}

/**
 * 编辑器卸载时调用。分屏有两个编辑器：谁卸载都直接清空的话，
 * 关掉分屏会把主编辑器也变成「没有当前编辑器」，F2 / 快速修复随即失灵。
 */
export function releaseCurrentEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
  if (current === editor) current = null;
}

function editor(): monaco.editor.IStandaloneCodeEditor | null {
  if (current && !current.getModel()?.isDisposed()) return current;
  // `getEditors()` 给的是 ICodeEditor（可能只是 diff 面板之类），这里只在兜底路径上用
  return (monaco.editor.getEditors()[0] as monaco.editor.IStandaloneCodeEditor | undefined) ?? null;
}

/** 命令面板里的一条编辑器动作。`action` 是 Monaco 的内置 command id。 */
export interface EditorCommand {
  id: string;
  title: string;
  action: string;
  /** 只有 java 文件才有意义（格式化 / 快速修复 / 跳转都依赖 jdt.ls）。 */
  javaOnly: boolean;
}

/**
 * 登记给命令面板的动作清单。
 *
 * `title` 里刻意带括号说明：命令面板是搜索框，用户敲「引用」「格式化」「父类」都能命中，
 * 但光写「找引用」他可能不知道要不要先选中。括号里那句就是给这一刻看的。
 */
export const EDITOR_COMMANDS: EditorCommand[] = [
  {
    id: "editor.references",
    title: "找引用（这个类 / 方法 / 字段用在哪儿）",
    action: "editor.action.referenceSearch.trigger",
    javaOnly: true,
  },
  {
    id: "editor.quickfix",
    title: "快速修复（Alt+Enter：补 import、改类型、生成方法）",
    action: "editor.action.quickFix",
    javaOnly: true,
  },
  {
    id: "editor.format",
    title: "格式化当前文件",
    action: "editor.action.formatDocument",
    javaOnly: true,
  },
  {
    id: "editor.implementation",
    title: "跳到实现（接口 → 实现类）",
    action: "editor.action.goToImplementation",
    javaOnly: true,
  },
  {
    id: "editor.typenav",
    title: "跳到父类 / 声明类型",
    action: "editor.action.goToTypeDefinition",
    javaOnly: true,
  },
  {
    id: "editor.peekdef",
    title: "定义预览（Alt+F12：在本窗口里看一眼，不跳走）",
    action: "editor.action.peekDefinition",
    javaOnly: true,
  },
  // 多光标：Monaco 都有现成命令，这里只是把它们列进命令面板，
  // 不用记「Alt+J / Ctrl+Alt+↓ / Ctrl+Alt+Shift+↓」也能找到。
  {
    id: "editor.multiNext",
    title: "多光标：选中下一个相同词（Alt+J）",
    action: "editor.action.addSelectionToNextFindMatch",
    javaOnly: false,
  },
  {
    id: "editor.multiAll",
    title: "多光标：选中所有相同词（Ctrl+Shift+L）",
    action: "editor.action.selectHighlights",
    javaOnly: false,
  },
  {
    id: "editor.multiAbove",
    title: "多光标：在上一行加一个光标（Ctrl+Alt+↑）",
    action: "editor.action.insertCursorAbove",
    javaOnly: false,
  },
  {
    id: "editor.multiBelow",
    title: "多光标：在下一行加一个光标（Ctrl+Alt+↓）",
    action: "editor.action.insertCursorBelow",
    javaOnly: false,
  },
  {
    id: "editor.columnUp",
    title: "列选择：向上扩一列（Ctrl+Alt+Shift+↑）",
    action: "cursorColumnSelectUp",
    javaOnly: false,
  },
  {
    id: "editor.columnDown",
    title: "列选择：向下扩一列（Ctrl+Alt+Shift+↓）",
    action: "cursorColumnSelectDown",
    javaOnly: false,
  },
];

/**
 * 执行一条编辑器动作。返回 false 表示当前没有可用的编辑器（比如焦点不在编辑器上）。
 *
 * `trigger` 比 `getAction().run()` 稳：内置 command 有 action 也有纯 command，
 * 后者没有 `getAction` 包装，取到的可能是 undefined。
 */
export function runEditorCommand(action: string): boolean {
  const ed = editor();
  if (!ed) return false;
  ed.trigger("ncforge-editor-cmd", action, null);
  return true;
}

/** 当前编辑器里是不是 java 文件（命令面板据此禁用。`null` 视为不可用）。 */
export function currentIsJava(): boolean {
  const ed = editor();
  const model = ed?.getModel();
  return model?.getLanguageId() === "java";
}

/** 光标位置的单词（重命名对话框拿它当默认值）。没有编辑器就是空串。 */
export function wordAtCursor(): string {
  const ed = editor();
  const pos = ed?.getPosition();
  const model = ed?.getModel();
  if (!pos || !model) return "";
  return model.getWordAtPosition(pos)?.word ?? "";
}

/**
 * 当前编辑器的快照：文件路径 + 全文 + 光标位置。
 *
 * 代码生成要先读全文找字段，生成完再插回去；两次读取必须来自同一个 model，
 * 中间用户如果切了标签就会对不上——调用方拿到快照后一次性算完。
 */
export function editorSnapshot(): {
  path: string | null;
  text: string;
  line: number;
  column: number;
  isJava: boolean;
} | null {
  const ed = editor();
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  if (!ed || !model || !pos) return null;
  return {
    path: pathOfModel(model) ?? null,
    text: model.getValue(),
    line: pos.lineNumber,
    column: pos.column,
    isJava: model.getLanguageId() === "java",
  };
}

/**
 * 在光标处插入文本（有选区就替换选区）。
 *
 * 只改编辑器 model，不落盘——与 jdt.ls 的代码修复同一条红线：写不写由用户决定。
 * 插入后把光标放到文本末尾，紧接着就能继续敲。
 */
export function insertEditorText(text: string): boolean {
  const ed = editor();
  const sel = ed?.getSelection();
  if (!ed || !sel) return false;
  ed.executeEdits("ncforge-generate", [{ range: sel, text, forceMoveMarkers: true }]);
  const pos = ed.getPosition();
  if (pos) ed.setPosition({ lineNumber: pos.lineNumber, column: pos.column });
  ed.focus();
  return true;
}

/** 当前 model（代码生成 / 组织导入要用它，而不是编辑器）。 */
export function currentModel(): ReturnType<typeof monaco.editor.createModel> | null {
  return editor()?.getModel() ?? null;
}

/**
 * 在指定行首插入文本（代码生成用：生成的方法要落在类体末尾，不是光标所在处）。
 *
 * 光标会跟到插入内容的末尾——刚生成完就想接着改是常态。
 */
export function insertEditorTextAtLine(text: string, line: number): boolean {
  const ed = editor();
  const model = ed?.getModel();
  if (!ed || !model) return false;
  const target = Math.min(Math.max(1, line), model.getLineCount());
  model.pushEditOperations(
    [],
    [{ range: new monaco.Range(target, 1, target, 1), text }],
    () => null,
  );
  const lines = text.split("\n").length;
  ed.setPosition({ lineNumber: Math.min(target + lines - 1, model.getLineCount()), column: 1 });
  ed.focus();
  return true;
}

/** 光标位置（1 基）。命令面板里的动作没有事件参数，只能这样取。 */
export function cursorAt(): { line: number; column: number } | null {
  const pos = editor()?.getPosition();
  return pos ? { line: pos.lineNumber, column: pos.column } : null;
}

/**
 * 当前选区快照（1 基，Monaco 语义）+ 所在 model。
 *
 * 重构这类「拿选定范围去问语言服务」的动作不能用 `cursorAt`：选区被整个丢掉，
 * 提取方法会把整段语句当成一个点。`readOnly` 也一起带出来——只读标签（混合换行、
 * jar 内文件）改了存不进去，必须在动手前拦住。
 */
export function currentSelection(): {
  model: ReturnType<typeof monaco.editor.createModel>;
  start: { line: number; column: number };
  end: { line: number; column: number };
  empty: boolean;
  readOnly: boolean;
} | null {
  const ed = editor();
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel) return null;
  return {
    model,
    start: { line: sel.startLineNumber, column: sel.startColumn },
    end: { line: sel.endLineNumber, column: sel.endColumn },
    empty: sel.isEmpty(),
    readOnly: ed.getOption(monaco.editor.EditorOption.readOnly),
  };
}

/** 选中一段并聚焦（重构后把生成的名字选中，紧接着按 F2 就能改名）。 */
export function selectInEditor(
  start: { line: number; column: number },
  end: { line: number; column: number },
): boolean {
  const ed = editor();
  if (!ed || !ed.getModel()) return false;
  const range = new monaco.Range(start.line, start.column, end.line, end.column);
  ed.setSelection(range);
  ed.revealRangeInCenterIfOutsideViewport(range);
  ed.focus();
  return true;
}

/**
 * F2 的动作。重命名要走自己的「先预览再写」流程（Monaco 内置的那套只改打开的 model），
 * 所以这里只留一个回调，由文件页挂上。
 */
let renameRequest: (() => void) | null = null;

export function setRenameRequest(fn: (() => void) | null): void {
  renameRequest = fn;
}

/** Alt+Insert（生成代码）同样由文件页挂上，对话框在那里渲染。 */
let generateRequest: (() => void) | null = null;

export function setGenerateRequest(fn: (() => void) | null): void {
  generateRequest = fn;
}

/**
 * 给编辑器补 `Alt+Enter` 与 `F2`。
 *
 * 只补这一个键：Monaco 内置 `Ctrl+.` 也能触发快速修复，两条路都能到，不占用户记忆。
 * `addCommand` 返回的是 command id 而不是 disposable，所以没有返回值——
 * 编辑器实例销毁时这条绑定跟着没了，不留悬挂。
 */
export function registerEditorKeys(ed: monaco.editor.IStandaloneCodeEditor): void {
  ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
    // 有代码智能时走 jdt.ls 的 quick fix；没有 provider 时 Monaco 自己什么都不做，不会报错
    ed.trigger("ncforge-editor-key", "editor.action.quickFix", null);
  });
  // F2 = 重命名，IDEA 的老习惯。Monaco 自己那个 rename 只改打开的 model，
  // 跨文件会改一半，所以这里接自己的流程（见 lib/renameSymbol.ts）
  ed.addCommand(monaco.KeyCode.F2, () => renameRequest?.());
  // Alt+Insert = 生成代码（构造器 / getter / setter / toString…），IDEA 同键
  ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Insert, () => generateRequest?.());
  // 多光标：IDEA 用 Alt+J 逐个选中下一个相同词，Monaco 的内置动作就是这个
  ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyJ, () => {
    ed.trigger("ncforge-generate", "editor.action.addSelectionToNextFindMatch", null);
  });
}
