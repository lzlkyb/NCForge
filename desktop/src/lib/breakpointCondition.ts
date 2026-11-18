// 断点「条件 / 命中次数 / 日志消息」的静态校验。
//
// 为什么前端要校验（探针结论，java-debug 0.32.0）：
// - condition 由适配器在「命中时」才交给 JDT 编译（evaluateForBreakpoint 按线程
//   缓存编译结果）。setBreakpoints 阶段没有任何语法检查，写错的表达式要到断点
//   真被命中那一刻才失败，且失败信息只出现在适配器侧。
// - hitCondition 更干脆：SetBreakpointsRequestHandler 只 Integer.parseInt，
//   ">=5" / "%5" 解析失败静默按 0 处理（= 根本没有命中过滤）。
// - logMessage 由 logMessageToExpression 拼进 Java 字符串字面量再交给 JDT：
//   英文引号 / 反斜杠 / 空 {} 会让生成代码编译失败，日志断点静默失效。
//
// 这里只做便宜的静态检查：把「注定编译失败」和「注定被忽略」的写法挡在保存前，
// 错误文案直接说明适配器的真实能力范围。类型对错（条件结果不是 boolean 之类）
// 静态查不了，由运行时的 usernotification 事件兜底（见 debugSession.ts）。
//
// 纯函数，便于单测。

/** 条件长度上限：再长就不是「一个判断」而是粘进来的代码段。 */
export const MAX_CONDITION_LEN = 500;

/** 语句开头关键字：条件只能是表达式，这些词开头的一定是语句。`new` 不在内——`new X().ok()` 是合法表达式。 */
const STATEMENT_HEADS = new Set([
  "if", "for", "while", "switch", "do", "try", "return", "throw", "break",
  "continue", "else", "case", "finally", "catch", "synchronized", "assert",
]);

/** 比较运算符里含 `=` 的前缀字符：`!=` / `<=` / `>=` 的 `=` 不是赋值（`+=` 这类复合赋值照样拒）。 */
const COMPARE_PREV = "!<>";

interface ExprScan {
  /** 引号与圆括号/方括号是否全部闭合。 */
  balanced: boolean;
  /** 没闭上的引号位置（-1 = 都闭了）。 */
  openQuoteAt: number;
  /** 第一个配不上的括号位置（-1 = 都配对）。 */
  unbalancedAt: number;
  /** 分号位置（-1 = 没有）。 */
  semiAt: number;
  /** 换行位置（-1 = 没有）。 */
  newlineAt: number;
  /** 赋值号位置（==/!=/<=/>= 与 :: 不算；-1 = 没有）。 */
  assignAt: number;
  /** 三元 / 方法引用之外的冒号位置（-1 = 没有）。 */
  badColonAt: number;
}

/**
 * 扫一遍表达式：跳过字符串/字符字面量，记录各类「语句级」痕迹的位置。
 * 第一个不闭合处即停（first-error-wins，错误位置才指得准）。
 */
function scanExpression(text: string): ExprScan {
  const scan: ExprScan = {
    balanced: true, openQuoteAt: -1, unbalancedAt: -1,
    semiAt: -1, newlineAt: -1, assignAt: -1, badColonAt: -1,
  };
  const open: Array<"(" | "["> = [];
  let quote: string | null = null;
  let questionAt = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "\n" && scan.newlineAt < 0) scan.newlineAt = i; // 不 break：继续扫，配平结果才准
    if (ch === ";" && scan.semiAt < 0) scan.semiAt = i;
    if (ch === "(") open.push("(");
    else if (ch === "[") open.push("[");
    else if (ch === ")" || ch === "]") {
      const want = ch === ")" ? "(" : "[";
      if (open.length === 0 || open[open.length - 1] !== want) {
        scan.balanced = false;
        scan.unbalancedAt = i;
        break;
      }
      open.pop();
    } else if (ch === "=") {
      const next = text[i + 1] ?? "";
      const prev = text[i - 1] ?? "";
      if (next === "=") i++;                                   // == 比较
      else if (COMPARE_PREV.includes(prev)) { /* != <= >=，判断 */ }
      else if (scan.assignAt < 0) scan.assignAt = i;           // = 或 += 等复合赋值
    } else if (ch === ":") {
      const prev = text[i - 1] ?? "";
      const next = text[i + 1] ?? "";
      if (prev !== ":" && next !== ":" && questionAt < 0 && scan.badColonAt < 0) {
        scan.badColonAt = i;                                   // 非三元、非 A::b 的冒号
      }
    } else if (ch === "?") questionAt = i;
  }
  if (scan.balanced && quote !== null) {
    scan.balanced = false;
    scan.openQuoteAt = text.length; // 引号没闭：位置指到末尾
  }
  if (scan.balanced && open.length > 0) {
    scan.balanced = false;
    scan.unbalancedAt = open[0] === "(" ? text.indexOf("(") : text.indexOf("[");
  }
  return scan;
}

const firstWord = (text: string): string | null => {
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text);
  return m ? m[0] : null;
};

/** 校验一个 Java 表达式（断点条件、日志占位符里的表达式共用）。空串 = 没填，合法。 */
export function validateCondition(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (t.length > MAX_CONDITION_LEN) {
    return `表达式太长了（${t.length} 字符）：这里只放单个表达式，不要粘代码段`;
  }
  const scan = scanExpression(t);
  if (scan.newlineAt >= 0) return "表达式不能跨行：只支持单个表达式";
  if (!scan.balanced) {
    return scan.openQuoteAt >= 0 ? "表达式里有没闭好的引号" : "表达式的圆括号 / 方括号不配对";
  }
  // 语句头优先于分号：粘进来的 `if (x) y();` 病根是 if，不是分号
  const head = firstWord(t);
  if (head && STATEMENT_HEADS.has(head)) return `表达式不能以 ${head} 开头：只支持表达式，不是语句`;
  if (t.startsWith("{")) return "表达式不能是代码块 { … }";
  if (scan.semiAt >= 0) return "表达式里不能有分号 ;：只支持单个表达式，不是语句";
  if (scan.assignAt >= 0) return "表达式里不能用赋值（= / += 等）：只做判断，不要改值";
  if (scan.badColonAt >= 0) return "表达式里的 : 只出现在三元 a ? b : c 或方法引用 A::b 中";
  return null;
}

/**
 * 校验命中次数。适配器 0.32.0 只 Integer.parseInt 后 addCountFilter：
 * 只有「第 N 次命中才停」一种语义；>=N / %N 解析失败被静默忽略。
 */
export function validateHitCondition(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^[1-9]\d*$/.test(t)) {
    if (/^[><=]/.test(t) || t.includes("%")) {
      return "当前调试适配器只支持「第 N 次命中才停」的整数（如 5）；>=N、%N 这类写法会被静默忽略";
    }
    if (/^\d+$/.test(t)) return "命中次数至少为 1";
    return "命中次数只支持正整数（如 5）";
  }
  return null;
}

/** 适配器拼日志代码用的正则：非贪婪、不跨行（`.` 不含换行）。这里必须同款，否则校验与实跑不一致。 */
const PLACEHOLDER_SRC = "\\{(.*?)\\}";

/** 找出全部占位符（新正则实例：`g` 标志的 lastIndex 不能跨调用复用）。 */
function findPlaceholders(text: string): RegExpExecArray[] {
  const re = new RegExp(PLACEHOLDER_SRC, "g");
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m);
  return out;
}

/**
 * 有没有「落单的 %」。String.format 里 %% 才是转义；%%% 这种也要抓
 * （前两个成对，第三个开始就是残缺格式符）。正则写不好这个，手写循环。
 */
function hasLonePercent(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "%") continue;
    if (text[i + 1] === "%") {
      i++;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * 校验日志消息（日志断点）。适配器把它拼成：
 *   有占位符 → System.out.println(String.format("消息", (expr1), (expr2)))
 *   无占位符 → System.out.println("消息")
 * 消息文本原样进 Java 字符串字面量，所以英文引号 / 反斜杠是编译级地雷；
 * 有占位符时走 String.format，单独的 % 会被当格式符（%% 才是转义）。
 */
export function validateLogMessage(text: string): string | null {
  if (!text.trim()) return null;
  const matches = findPlaceholders(text);
  for (const m of matches) {
    const inner = m[1];
    if (!inner.trim()) return "{} 里要写表达式：如 {vo.getCode()}";
    const innerErr = validateCondition(inner);
    if (innerErr) return `{${inner}} 不是合法表达式：${innerErr}`;
  }
  // 占位符整体抠掉后：剩下的文本里再有花括号，说明适配器的非贪婪匹配会错位
  const stripped = text.replace(new RegExp(PLACEHOLDER_SRC, "g"), "");
  if (/[{}]/.test(stripped)) {
    return "花括号不成对：适配器只按 {表达式} 解析，多余的 { 或 } 会让插值错位";
  }
  const bad = /["\\]/.exec(stripped);
  if (bad) {
    return bad[0] === '"'
      ? "英文双引号 \" 会原样拼进生成的 Java 代码、让输出失败：请改用中文引号」"
      : "反斜杠 \\ 会原样拼进生成的 Java 代码、让输出失败：请去掉";
  }
  if (matches.length > 0 && hasLonePercent(stripped)) {
    return "同时含 % 和 {表达式} 时适配器无法解析（% 是格式符）：请改用全角％";
  }
  return null;
}

export interface BreakpointDraftErrors {
  condition: string | null;
  hitCondition: string | null;
  logMessage: string | null;
}

/** 编辑草稿的三项校验：供表单即时提示与「保存」禁用判定。 */
export function draftErrors(draft: {
  condition: string;
  hitCondition: string;
  logMessage: string;
}): BreakpointDraftErrors {
  return {
    condition: validateCondition(draft.condition),
    hitCondition: validateHitCondition(draft.hitCondition),
    logMessage: validateLogMessage(draft.logMessage),
  };
}

export function hasDraftErrors(errors: BreakpointDraftErrors): boolean {
  return errors.condition !== null || errors.hitCondition !== null || errors.logMessage !== null;
}
