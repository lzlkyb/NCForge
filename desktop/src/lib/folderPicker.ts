// 工程目录只通过系统文件夹选择器挑，不让用户手打路径。
//
// 对话框由后端 `pick_folder` 命令拉起（不把 `dialog:` 权限授予 WebView）：
// 返回的是用户明确点选的目录，省掉「路径不存在 / 斜杠方向 / 手误」这三类失败。
import { invoke } from "./tauri";

/** 打开系统文件夹选择框。用户取消返回 null；后端异常时抛出原因。 */
export async function pickFolder(
  options: { title?: string; defaultPath?: string } = {},
): Promise<string | null> {
  return invoke<string | null>("pick_folder", {
    title: options.title ?? null,
    // invoke 序列化会丢掉 undefined 键，显式给 null
    defaultPath: options.defaultPath ?? null,
  });
}

/** 选择器本身失败时的统一文案（路径不合法由 `onOpen` 另外回报）。 */
export function pickFolderError(e: unknown): string {
  return `无法打开文件夹选择框：${e instanceof Error ? e.message : String(e)}`;
}
