// 单个文件只通过系统文件选择器挑；与目录选择器同一套约束（对话框由后端拉起）。
import { invoke } from "./tauri";

export interface PickFileOptions {
  title?: string;
  defaultPath?: string;
  /** 仅用于对话框筛选，不替代调用方的扩展名校验。 */
  extensions?: string[];
}

/** 打开系统文件选择框。用户取消返回 null；后端异常时抛出原因。 */
export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
  return invoke<string | null>("pick_file", {
    title: options.title ?? null,
    defaultPath: options.defaultPath ?? null,
    extensions: options.extensions?.length ? options.extensions : null,
  });
}
