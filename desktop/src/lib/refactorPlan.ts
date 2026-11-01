// 提取类重构的纯逻辑：请求参数，以及结果里「新名字」的位置。
//
// 单独一个文件（理由同 `renameEdits.ts`）：`refactor.ts` 要经 `editorActions` 引 Monaco，
// 纯函数跟过去，单测环境没有 window 就一条都跑不起来。
import type { LspRange } from "./langConvert";

/**
 * jdt.ls 0.57 的 `java/getRefactorEdit` 认这四种提取。
 *
 * 命令名来自插件包里的字面量（`GetRefactorEditHandler`），不是我自己起的：
 * 写成 `java/extractMethod` 之类服务端只会回 null，看起来像「选中的内容不能提取」。
 */
export type RefactorKind = "extractMethod" | "extractVariable" | "extractField" | "extractConstant";

export const REFACTOR_KINDS: Record<RefactorKind, { label: string; need: string }> = {
  extractMethod: { label: "提取方法", need: "要提取的一段语句" },
  extractVariable: { label: "提取局部变量", need: "要提取的表达式" },
  extractField: { label: "提取字段", need: "要提取的表达式或局部变量" },
  extractConstant: { label: "提取常量", need: "要提取的字面量或表达式" },
};

/**
 * `java/getRefactorEdit` 的请求参数。
 *
 * `textDocument.uri` 刻意留空：前端拿真实路径算出的 URI 与后端 `path_to_uri` 的
 * 编码形态不一致（Monaco 把盘符冒号写成 `%3A`），前后缀替换换不掉；后端会按
 * `path` 参数把影子工程 URI 填进这里（`fill_document_uris`）。
 */
export function refactorParams(
  kind: RefactorKind,
  range: LspRange,
  tabSize: number,
  insertSpaces: boolean,
): Record<string, unknown> {
  return {
    command: kind,
    commandArguments: [],
    context: {
      textDocument: { uri: "" },
      range,
      context: { diagnostics: [] },
    },
    options: { tabSize, insertSpaces },
  };
}

/** 响应形状：`{ edit, command?, errorMessage? }`；服务端放弃时整个是 null。 */
export interface RefactorResponse {
  edit?: unknown;
  command?: { command?: string; arguments?: unknown[] };
  errorMessage?: string;
}

/**
 * 提取完成后新名字在**结果文本**里的偏移（UTF-16，与 Monaco 坐标系一致）。
 *
 * 只有带联动改名位置的提取（变量 / 字段 / 常量）会返回 `java.action.rename`；
 * 提取方法给的是一个固定默认名（`extracted`），没有 command。
 *
 * 不拿 command 里的 uri 和当前路径比对：它由被重构的那个编译单元构造，
 * 一定是当前文件，而 URI 的编码形态各家不同，比对反而会漏。
 */
export function newNameSpan(res: RefactorResponse): { offset: number; length: number } | null {
  const cmd = res.command;
  if (!cmd || cmd.command !== "java.action.rename") return null;
  const arg = cmd.arguments?.[0] as { offset?: unknown; length?: unknown } | undefined;
  if (!arg || typeof arg.offset !== "number" || typeof arg.length !== "number") return null;
  if (!Number.isInteger(arg.offset) || !Number.isInteger(arg.length)) return null;
  if (arg.offset < 0 || arg.length <= 0) return null;
  return { offset: arg.offset, length: arg.length };
}
