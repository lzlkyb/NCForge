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

/** 光标位置（1 基）。命令面板里的动作没有事件参数，只能这样取。 */
export function cursorAt(): { line: number; column: number } | null {
  const pos = editor()?.getPosition();
  return pos ? { line: pos.lineNumber, column: pos.column } : null;
}

/**
 * F2 的动作。重命名要走自己的「先预览再写」流程（Monaco 内置的那套只改打开的 model），
 * 所以这里只留一个回调，由文件页挂上。
 */
let renameRequest: (() => void) | null = null;

export function setRenameRequest(fn: (() => void) | null): void {
  renameRequest = fn;
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
}
