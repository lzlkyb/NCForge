/**
 * 错误契约的解析与比较（纯函数，配单测）。
 *
 * 判据：**`#[tauri::command]` 的返回类型是 `Result<_, String>` 就算违规**。
 * 这类命令把错误压平成一串英文，前端只能靠正则猜语义（见 `app_error.rs` 头注释）。
 *
 * 只认命令：普通内部函数返 `String` 是合理的（比如 `format_entry`），
 * 跨 IPC 才需要结构。
 */

/** 从一段返回类型里取顶层泛型参数。`Result<HashMap<String, u32>, String>` → 两个。 */
export function splitTopLevel(type) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of type) {
    if (ch === "<" || ch === "(" || ch === "[") depth += 1;
    if (ch === ">" || ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 归一：去掉类型里的空白，`Result<T , String >` 与 `Result<T,String>` 等价。 */
const squash = (s) => s.replace(/\s+/g, "");

/**
 * `Result<..., String>` 判定。
 *
 * 认三种写法：`Result<T, String>`、`std::result::Result<T, String>`、
 * 以及带路径的 `Result<T, std::string::String>`。**不认**自定义的同名类型——
 * 那需要语义分析，静态扫做不到，宁可漏也不误报（误报会教人加豁免）。
 */
export function isStringResult(retType) {
  const t = squash(retType ?? "");
  const m = t.match(/^(?:std::result::)?Result<(.+)>$/);
  if (!m) return false;
  const args = splitTopLevel(m[1]);
  if (args.length !== 2) return false;
  const err = squash(args[1]);
  return err === "String" || err === "std::string::String";
}

/**
 * 从 Rust 源码里抽「命令名 → 返回类型」。
 *
 * 手写扫描而不是一条大正则：签名会跨行（参数多、泛型多），而返回类型与函数体
 * 之间还夹着 `-> `。关键是**只在函数体之前**找 `->`，否则会把函数体里的闭包签名
 * 也算进来。
 *
 * 做法：定位 `fn name(`，用括号平衡跳到参数表结束，然后在第一个 `{` 之前找 `->`。
 */
export function scanCommands(source) {
  const found = [];
  const MARK = /#\[tauri::command\]/g;
  let mark;
  while ((mark = MARK.exec(source))) {
    const from = mark.index;
    // 命令宏与 fn 之间只会夹属性行/注释，给 300 字符足够
    const head = source.slice(from, from + 300);
    const fn = head.match(/\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/);
    if (!fn) continue;
    const name = fn[1];
    const paramStart = from + fn.index + fn[0].length;
    // 括号平衡：参数表里可能有闭包 `|x| -> T`、泛型、元组类型
    let depth = 1;
    let i = paramStart;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    const afterParams = source.slice(i);
    // 函数体起点；`where` 子句也在这之前结束
    const bodyAt = afterParams.indexOf("{");
    const signatureTail = bodyAt >= 0 ? afterParams.slice(0, bodyAt) : afterParams.slice(0, 300);
    const arrow = signatureTail.indexOf("->");
    const retType = arrow >= 0 ? signatureTail.slice(arrow + 2).trim() : "";
    found.push({ name, retType, line: source.slice(0, from).split("\n").length });
  }
  return found;
}

/** 收集所有返 `Result<_, String>` 的命令名（去重、排序，便于直接比对基线）。 */
export function stringResultCommands(source) {
  return scanCommands(source)
    .filter((c) => isStringResult(c.retType))
    .map((c) => c.name)
    .sort();
}

/**
 * 读基线文件，容错两种形态。
 *
 * 新形态是 `{ note, commands, exempt }`；老形态是裸数组。`exempt` 是
 * **必须写理由的破例表**（`{ 命令名: 为什么破例 }`），不是第二个基线：
 * `commands` 是「历史存量，只许减」，`exempt` 是「明确决定不迁，且有原因」。
 *
 * 🔴 分成两张表是因为 2026-11-17 真踩过：`svn_file_commits` 是这轮新写的命令，
 * 却因为「先写命令、后跑 `--update`」被静默吸收进基线——门禁本来该在那一刻红。
 * 现在破例必须写进 `exempt`，代码 review 时看得见。
 */
export function normalizeBaseline(raw) {
  if (Array.isArray(raw)) return { commands: raw, exempt: {} };
  const commands = Array.isArray(raw?.commands) ? raw.commands : [];
  const exempt = {};
  for (const [name, reason] of Object.entries(raw?.exempt ?? {})) {
    if (typeof reason === "string" && reason.trim()) exempt[name] = reason;
  }
  return { commands, exempt };
}

/**
 * 与基线比较。
 *
 * - `added`：**新增**的空字符串错误命令 → 必须红。这是门禁的全部意义。
 *   豁免表里的不算新增（但豁免本身要有理由，见 [`normalizeBaseline`]）。
 * - `migrated`：基线里有、现在没了（已迁移或命令被删）→ 只提示，不红。
 *   红了会逼人「为了过门禁去改基线」，与「只许减」的方向相反。
 * - `staleExempt`：豁免表里有、但现在已不再返 String（迁移完了或命令删了）→
 *   提示删掉那条豁免。留着会让「破例」永久有效，等于没有契约。
 */
export function diffAgainstBaseline(current, baseline, exempt = {}) {
  const cur = new Set(current);
  const base = new Set(baseline);
  const waived = new Set(Object.keys(exempt));
  return {
    added: current.filter((n) => !base.has(n) && !waived.has(n)),
    migrated: baseline.filter((n) => !cur.has(n)),
    staleExempt: [...waived].filter((n) => !cur.has(n)),
  };
}
