// 暂停行的内联变量值（IDEA 的「调试时在行尾显示变量值」）。
//
// 数据源就是 `debugSession` 快照里当前帧的 scopes + variables——与右侧变量面板
// 同一份数据，不另发请求。这里只做「帧 + 变量 → 行尾文案」，画不画由调用方
// （debugGutter）决定。
//
// 范围刻意收窄：**只画当前选中帧的那一行**。IDEA 会给方法体内每条语句标使用点，
// 那需要语句级数据流（哪行读了哪个变量），DAP 给不了；当前行的全部局部变量
// 覆盖了「停下来先看一眼值」这个主场景，且不会在方法体内到处贴噪音。
import type { DapScope, DapVariable } from "./debug";

export interface InlineValueHint {
  line: number;
  /** 行尾内容（前导分隔符由调用方加）。 */
  label: string;
}

interface Options {
  /** 最多列几个变量：一屏放得下的才是「瞥一眼」，多了盖住代码。 */
  maxVars: number;
  /** 单个值的长度上限：大对象的 toString 能有一屏。 */
  maxValueLen: number;
  /** 整条文案的长度上限。 */
  maxLabelLen: number;
}

const DEFAULTS: Options = { maxVars: 8, maxValueLen: 48, maxLabelLen: 160 };

/** 单值清洗：折行压平（toString 里的 \n 会把行尾撑飞）、超长截断。 */
function cleanValue(raw: string, maxLen: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
}

/**
 * 当前帧的内联值提示。scopes 决定顺序（局部变量在前），variables 按
 * variablesReference 取；某个作用域的变量还没拉到（异步展开）时自然跳过。
 */
export function inlineValueHints(
  frame: { line: number },
  scopes: DapScope[],
  variables: Record<number, DapVariable[]>,
  opts: Partial<Options> = {},
): InlineValueHint[] {
  const { maxVars, maxValueLen, maxLabelLen } = { ...DEFAULTS, ...opts };
  if (!Number.isInteger(frame.line) || frame.line < 1) return [];
  const parts: string[] = [];
  for (const scope of scopes) {
    for (const v of variables[scope.variablesReference] ?? []) {
      if (parts.length >= maxVars) break;
      const name = v.name?.trim();
      // this 不进内联：每个方法都有同一个它，画上去只是噪音
      if (!name || name === "this") continue;
      const value = cleanValue(v.value ?? "", maxValueLen);
      if (!value) continue;
      parts.push(`${name} = ${value}`);
    }
    if (parts.length >= maxVars) break;
  }
  if (parts.length === 0) return [];
  const label = parts.join(", ");
  return [{ line: frame.line, label: label.length > maxLabelLen ? `${label.slice(0, maxLabelLen - 1)}…` : label }];
}
