// 调试步进键的编辑器绑定。
//
// 单独成文件而不是塞进 `debugKeys`：那个模块被服务页与纯逻辑单测引用，
// 拉进 Monaco 会把整条 editor 依赖链（worker/剪贴板检测）带进 jsdom 用例。
import { monaco } from "./monacoSetup";
import { debugActionForKey, runDebugAction, type DebugKeyCode } from "./debugKeys";

/**
 * 把调试步进键绑到编辑器。
 *
 * 不在注册时决定 F7 的含义：同一枚 F 键在 Eclipse / IDEA 方案里不同，
 * 到按键那一刻再查当前方案；不在方案里的键什么也不做。
 */
export function registerDebugEditorKeys(editor: monaco.editor.IStandaloneCodeEditor): void {
  const keys: [DebugKeyCode, number][] = [
    ["F5", monaco.KeyCode.F5],
    ["F6", monaco.KeyCode.F6],
    ["F7", monaco.KeyCode.F7],
    ["F8", monaco.KeyCode.F8],
    ["F9", monaco.KeyCode.F9],
  ];
  for (const [code, key] of keys) {
    editor.addCommand(key, () => {
      const action = debugActionForKey(code, false);
      if (action) runDebugAction(action);
    });
  }
  // Shift+F8 只在 IDEA 方案里是「步出」；Eclipse 方案下不接管
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F8, () => {
    const action = debugActionForKey("F8", true);
    if (action) runDebugAction(action);
  });
}
