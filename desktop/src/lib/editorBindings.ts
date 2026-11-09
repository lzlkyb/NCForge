import { monaco } from "./monacoSetup";
import { bindEditorCommand } from "./editorCommandBinding";
import { organizeImportsCommand } from "./javaActions";
import { runCallHierarchy } from "./callHierarchy";
import { runTypeHierarchy } from "./typeHierarchy";
import { registerRefactorKeys } from "./refactor";
import { toggleBookmark } from "./bookmarks";
import { setSession } from "./workspaceSession";
import { toggleBreakpointHere } from "./debugSession";
import { registerDebugEditorKeys } from "./debugEditorKeys";
import { previousEditSpot } from "./editHistory";
import { pathOfModel } from "./editorStore";
import { navigate } from "./lang";
import { editorCommand, getKeymap, isTypeHierarchyKey } from "./keymap";
import { toast } from "../components/ui/toast";

type Editor = ReturnType<typeof monaco.editor.create>;

/**
 * 编辑器创建时一次性注册的快捷键与按键分发。
 *
 * 这块是纯「装配」：不持有组件状态，只依赖 editor 实例和一个 saveNow 回调。
 * 从 EditorPane 抽出来是为了让组件只管实例生命周期、model 切换与清理，
 * 也避免把 80 行键位表塞进一个已经逼近行数上限的文件。
 */
export function registerEditorBindings(editor: Editor, saveNow: () => void) {
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
  return editor.onKeyDown(event => {
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
}
