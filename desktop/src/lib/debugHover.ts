// 调试悬停：暂停时把光标下的表达式发给适配器求值，光标移开自动消失。
//
// 与表结构悬停（monacoSetup 的 wireTableHover）是两个独立 provider：Monaco 会把
// 多个结果合并展示。这里只在调试器暂停时工作，其余时间完全让路。
import { monaco } from "./monacoSetup";
import { expressionAt } from "./debugExpression";
import { evaluateHover, getDebugSnapshot } from "./debugSession";

let wired = false;

/** 逃逸 Markdown 行内代码里的反引号，避免求值结果把格式截断。 */
const escapeCode = (text: string): string => text.replace(/`/g, "\\`");

export function wireDebugHover(): void {
  if (wired) return;
  wired = true;
  monaco.languages.registerHoverProvider("java", {
    provideHover: async (model, position) => {
      const snap = getDebugSnapshot();
      if (!snap.paused || !snap.frameId) return null;
      const expr = expressionAt(model.getLineContent(position.lineNumber), position.column);
      if (!expr) return null;
      const hit = await evaluateHover(expr);
      // 求值失败（类名、包名、未导入的符号）静默让路，不在悬停里报错
      if (!hit || hit.error || !hit.result) return null;
      const type = hit.type ? ` · ${escapeCode(hit.type)}` : "";
      // 不声明 range：表达式可能跨方法调用，算错高亮范围比不高亮更糟
      return {
        contents: [
          {
            value: `\`${escapeCode(expr)}\` = \`${escapeCode(hit.result)}\`${type}`,
            isTrusted: false,
          },
        ],
      };
    },
  });
}
