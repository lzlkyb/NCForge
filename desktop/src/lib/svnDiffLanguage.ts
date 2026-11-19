import { languageOfFormat } from "./fileFormats";

/**
 * diff 的语言与代码页同一真源（`languageOfFormat`）。
 *
 * 原先 DiffPane 里硬编码一张 11 项小表，upm/bmf/rest 等在代码页有 XML 高亮、
 * 审查 diff 却是纯文本——两套口径必然分叉。`text` 给 xml-content 格式
 * （rest/aop/mbe/mbp 与长尾 NC 设计模型）做正文嗅探；删除/空副本时
 * 调用方传 BASE 正文，避免空文本把 XML 判成纯文本。
 */
export function svnDiffLanguage(path: string, text?: string): string {
  return languageOfFormat(path, text);
}