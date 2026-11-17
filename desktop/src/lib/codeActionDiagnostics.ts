// `textDocument/codeAction` 的诊断上下文：挑哪些诊断、怎么转。
//
// 🔴 为什么需要这个文件（2026-11-17 反编译随包 jdt.ls 0.57 定位的真 bug）：
// 原先 `langProvidersExtra.ts` 传 `context: { diagnostics: [] }`，注释说
// 「jdt.ls 主要按 range 反查它自己那份诊断」——**与二进制实现不符**：
//   · `CodeActionHandler:120` `getProblemLocationCores(unit, params.getContext().getDiagnostics())`
//     ⇒ 问题位置**只**来自客户端传入的诊断，没有任何反查逻辑；
//   · `QuickFixProcessor:68` `if (locations.length == 0) return emptyList();`
//     ⇒ 空数组直接返回空，其后 **121 个 case 的 switch** 一次都进不去。
// 结果是 Java 里红波浪线上按 Ctrl+。一条「修复」都没有，只剩重构与 source 动作。
//
// 两条服务端行为决定了本文件的两个约束（都已反编译核实）：
//   1. `getProblemId` 把 `diagnostic.code` 解析成整数（字符串/数字都认），失败给 0；
//      `QuickFixProcessor.process` 见 `id == 0` 直接 return ⇒ **没有可解析 code 的诊断等于没传**。
//   2. `getProblemLocationCores` **不做 range 过滤**，传进去多少就全用
//      ⇒ 客户端必须自己筛到与请求 range 相交的那些，否则光标在 A 处会弹出 B 处的修复。
//
// 纯函数、无 monaco / 无 IO，便于单测钉住上面每一条。

/** LSP 位置（0 基行号与列号）。 */
export interface LspPos {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPos;
  end: LspPos;
}

/** 服务端发来的诊断原件。只声明本模块用得到的字段。 */
export interface SourceDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}

/** 传给服务端的诊断。字段名与 LSP 一致，多余字段会被 lsp4j 丢掉。 */
export interface CodeActionDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}

/**
 * `code` 能不能被服务端解析成非 0 problem id。
 *
 * 口径与服务端 `getProblemId` 对齐：它用 `Integer.parseInt` / `Number.intValue`，
 * 所以 `"1610612995"` 与 `1610612995` 都行，`"unused"`、`""`、`0`、`NaN` 都不行。
 * ⚠️ 不认十六进制字符串：服务端 `Integer.parseInt(s)` 不带 radix，`"0x1000"` 会抛异常 ⇒ 0。
 */
export function hasProblemId(code: string | number | undefined): boolean {
  if (typeof code === "number") return Number.isFinite(code) && Math.trunc(code) !== 0;
  if (typeof code !== "string") return false;
  const s = code.trim();
  // 只认十进制整数字面量（可带负号）：与服务端不带 radix 的 parseInt 一致。
  if (!/^-?\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0;
}

/** 位置比较：a 是否在 b 之前（同行比列）。 */
function before(a: LspPos, b: LspPos): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/**
 * 两个范围是否相交。
 *
 * 🔴 端点相接算相交：诊断范围通常是「单词」，而光标退化成一个点时
 * `range.start == range.end`，若按严格相交判，光标停在单词末尾就取不到诊断，
 * 用户会看到「明明有红波浪线却没有修复」。这与 Monaco 灯泡的口径一致。
 */
export function rangesIntersect(a: LspRange, b: LspRange): boolean {
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/**
 * 挑出该随这次 codeAction 一起发出去的诊断。
 *
 * 规则（每条都对应一种真实失败方式）：
 * - 只要与 `range` 相交的：服务端不筛，不筛就会给别处的修复。
 * - 只要有可解析 code 的：无 code 的传过去只会占位，服务端解析成 0 后丢弃。
 * - 按 problem id 去重：同一个问题在一条语句里可能报多次，服务端自己也用
 *   `handledProblems` 去重，这里先去一遍能少发数据、也让条数上限更有意义。
 * - 上限 `limit`：大文件一次可能有上千条诊断，全发过去会让请求体膨胀且服务端逐条建 AST。
 */
export function pickCodeActionDiagnostics(
  diags: readonly SourceDiagnostic[],
  range: LspRange,
  limit = 32,
): CodeActionDiagnostic[] {
  const out: CodeActionDiagnostic[] = [];
  const seen = new Set<string>();
  for (const d of diags) {
    if (out.length >= limit) break;
    if (!hasProblemId(d.code)) continue;
    if (!rangesIntersect(d.range, range)) continue;
    const key = String(d.code);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      range: d.range,
      message: d.message,
      severity: d.severity,
      source: d.source,
      code: d.code,
    });
  }
  return out;
}