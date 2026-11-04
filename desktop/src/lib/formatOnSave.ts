/**
 * 保存前格式化。
 *
 * 只做「保存这一刻」的格式化，不接管编辑器的格式化快捷键：用户按 Ctrl+S 的语义是
 * 「把现在看到的存下去」，如果先格式化，磁盘上的内容就必须是格式化后的那一份——
 * 反过来（先存再格式化）会留下一个「未保存」的假象，下一次保存又回到原文。
 *
 * 格式化失败不阻断保存：语言服务没就绪、语法错误都可能让它抛错，用户按了 Ctrl+S
 * 就该落盘，不能因为格式化没成而让这次保存无声消失。
 */
import { getEditorPrefs } from "./editorPrefs";

/** 只取用到的方法，测试可以注入假对象，不拉起整个 Monaco。 */
export interface SaveEditor {
  getModel(): { getLanguageId(): string } | null;
  getAction(id: string): { run(): Promise<void> } | null;
}

export async function formatBeforeSave(editor: SaveEditor): Promise<void | "failed"> {
  if (!getEditorPrefs().formatOnSave) return;
  if (editor.getModel()?.getLanguageId() !== "java") return;
  try {
    await editor.getAction("editor.action.formatDocument")?.run();
  } catch {
    // 语言服务未就绪 / 文档有语法错误：保留原文，保存照常进行
    return "failed";
  }
}
