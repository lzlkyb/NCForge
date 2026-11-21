/**
 * 从 Rust 源码里抽 `@ts-mirror` 标记的结构体，生成 TypeScript 类型。
 *
 * 🔴 为什么不引入 ts-rs / tauri-specta：
 * - `tauri-specta` 要在 `invoke_handler` 处再声明一份 `collect_commands![...]`，
 *   等于**第二份命令清单**——正是 `gen-command-contract.mjs` 花力气消灭的东西。
 * - `ts-rs` 用 derive 导出，准确，但导出要么挂在 `cargo test` 上（每次测试都写文件），
 *   要么单开一个 export bin，且版本间 API 变过几轮。换来的能力与本脚本几乎相同。
 *
 * 所以：**沿用现有脚本这一套（同一份源码、同一套门禁），只补「结构体 → TS」这一层。**
 * 生成物与手写类型的相等性由 `src/lib/bindings.check.ts` 的类型断言钉住，
 * 判据仍然是「改一个 Rust 字段，`tsc` 当场红」。
 *
 * 支持范围（超出即报错，绝不猜）：
 * - `pub struct Name { pub field: Type, ... }`，字段一行一个（rustfmt 的默认形态）
 * - 类型：基本标量 / `String` / `Vec<T>` / `Option<T>` / `HashMap<String, T>` / 已镜像的结构体
 * - 属性：`#[serde(rename = "..")]`、`#[serde(rename_all = "camelCase")]`、`#[serde(skip)]`
 *
 * 方向语义（必须区分，混用会写出后端不认的类型）：
 * - `// @ts-mirror response`（默认）：`Option<T>` → `field: T | null`
 * - `// @ts-mirror request`：`Option<T>` → `field?: T`（可以不传，而不是「传 null 表示不改」）
 */

/** 标记行允许带尾随说明（`// @ts-mirror response —— 为什么镜像它`），方向只看第一个词。 */
const MARKER = /^\/[/!]?\s*@ts-mirror\b/;
const directionOf = (line) => line.match(/\b(request|response)\b/)?.[1] ?? "response";
const PRIMITIVE = new Map([
  ["bool", "boolean"],
  ["String", "string"],
  ["&str", "string"],
  ["isize", "number"], ["usize", "number"],
  ["i8", "number"], ["i16", "number"], ["i32", "number"], ["i64", "number"], ["i128", "number"],
  ["u8", "number"], ["u16", "number"], ["u32", "number"], ["u64", "number"], ["u128", "number"],
  ["f32", "number"], ["f64", "number"],
]);

const camel = (s) => s.replace(/_+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());

/** `Option<...>` / `Vec<...>` / `HashMap<String, ...>` 的外层拆包。 */
function splitGeneric(type) {
  const m = type.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*<(.*)>$/s);
  if (!m) return { head: type.trim(), inner: null };
  return { head: m[1], inner: m[2].trim() };
}

/** 按顶层逗号切分泛型参数（`HashMap<String, Vec<T>>` 不能被第一个逗号切断）。 */
function splitArgs(inner) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tsType(type, known, ctx, depth = 0) {
  if (depth > 6) throw new Error(`${ctx}：类型嵌套过深，可能写错了`);
  const t = type.trim();
  if (PRIMITIVE.has(t)) return PRIMITIVE.get(t);
  const { head, inner } = splitGeneric(t);
  if (inner !== null) {
    if (head === "Vec") {
      const item = tsType(inner, known, ctx, depth + 1);
      // `Vec<Option<T>>` 是 `(T | null)[]`，不是 `T | null[]`——后者在 TS 里读成
      // 「T 或 null 数组」，语义完全不同
      return item.includes("|") ? `(${item})[]` : `${item}[]`;
    }
    if (head === "Option") return `${tsType(inner, known, ctx, depth + 1)} | null`;
    if (head === "HashMap" || head === "BTreeMap") {
      const [k, v] = splitArgs(inner);
      if (k !== "String" && k !== "&str") throw new Error(`${ctx}：Map 的键只支持 String，实际 ${k}`);
      return `Record<string, ${tsType(v, known, ctx, depth + 1)}>`;
    }
    throw new Error(`${ctx}：不支持的泛型 ${head}<...>（先在 ts-mirror.mjs 里加映射）`);
  }
  if (known.has(t)) return known.get(t) ?? t;
  throw new Error(`${ctx}：未知类型 ${t}（若它要过桥，给它加 // @ts-mirror）`);
}

/**
 * 第一趟：把每个被标记的结构体/枚举连 body 一起抠出来（还不知道谁引用了谁）。
 *
 * 枚举只为「配置里存字符串字面量」这一类存在（`ShadowMode` = `"flat" | "single"`）：
 * 它没有字段，生成的是一行 `export type X = "a" | "b"`。带负载的枚举（`Foo::Bar(v)`）
 * 一律报错 —— 那种形状 TS 侧该用可辨识联合，不是这里能猜的。
 */
function scanBlocks(text, file) {
  const lines = text.split("\n");
  const blocks = [];
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const marker = line.match(MARKER);
    if (marker) {
      pending = { direction: directionOf(line), attrs: [], at: i + 1 };
      continue;
    }
    if (line.startsWith("#[")) {
      if (pending) pending.attrs.push(line);
      continue;
    }
    if (line.startsWith("//") || line === "") continue;
    const head = line.match(/^pub (struct|enum) (\w+)\s*\{$/);
    if (!head || !pending) { pending = null; continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "}") j++;
    blocks.push({
      kind: head[1],
      name: head[2],
      direction: pending.direction,
      attrs: pending.attrs,
      body: lines.slice(i + 1, j),
      bodyStart: i + 2,
      file,
      line: i + 1,
      unterminated: j >= lines.length,
    });
    pending = null;
    i = j;
  }
  return blocks;
}

/** 枚举变体名 → 序列化后的字面量（`#[serde(rename)]` > `rename_all` > 原名）。 */
function parseEnumVariants(block) {
  const errors = [];
  const renameAll = block.attrs
    .map((a) => a.match(/^#\[serde\(rename_all\s*=\s*"(\w+)"\)\]$/)?.[1])
    .find(Boolean);
  const variants = [];
  let attrs = [];
  block.body.forEach((raw, idx) => {
    const body = raw.trim();
    if (body === "" || body.startsWith("//")) return;
    if (body.startsWith("#[")) { attrs.push(body); return; }
    const m = body.match(/^([A-Za-z_]\w*),$/);
    if (!m) {
      errors.push(
        `${block.file}:${block.bodyStart + idx}（${block.name}）：枚举变体只支持无负载的 \`Name,\`，实际：${body}`,
      );
      attrs = [];
      return;
    }
    const rename = attrs.map((a) => a.match(/^#\[serde\(rename\s*=\s*"([^"]+)"\)\]$/)?.[1]).find(Boolean);
    variants.push({
      source: m[1],
      literal: rename ?? (renameAll === "lowercase" ? m[1].toLowerCase() : renameAll === "camelCase" ? camel(m[1]) : m[1]),
    });
    attrs = [];
  });
  return { variants, errors };
}

function parseFields(block, known) {
  const errors = [];
  const fields = [];
  const renameAll = block.attrs
    .map((a) => a.match(/^#\[serde\(rename_all\s*=\s*"(\w+)"\)\]$/)?.[1])
    .find(Boolean);
  let attrs = [];
  block.body.forEach((raw, idx) => {
    const body = raw.trim();
    if (body === "" || body.startsWith("//")) return;
    if (body.startsWith("#[")) { attrs.push(body); return; }
    const fm = body.match(/^pub (\w+):\s*(.+),$/);
    if (!fm) {
      errors.push(`${block.file}:${block.bodyStart + idx}：${block.name} 的字段看不懂（要求一行一个 \`pub name: Type,\`）：${body}`);
      attrs = [];
      return;
    }
    if (attrs.some((a) => /^#\[serde\(skip[,)]/.test(a))) { attrs = []; return; }
    const rename = attrs.map((a) => a.match(/^#\[serde\(rename\s*=\s*"([^"]+)"\)\]$/)?.[1]).find(Boolean);
    const ctx = `${block.file}:${block.bodyStart + idx}（${block.name}.${fm[1]}）`;
    const rawType = fm[2];
    try {
      const outer = splitGeneric(rawType);
      // request 侧：Option<T> 是「可以不传」，提到字段层成 `?`
      const optional = outer.head === "Option" && block.direction === "request";
      const type = tsType(optional ? outer.inner : rawType, known, ctx);
      fields.push({
        name: rename ?? (renameAll === "camelCase" ? camel(fm[1]) : fm[1]),
        optional,
        type,
        source: fm[1],
      });
    } catch (e) {
      errors.push(String(e?.message ?? e));
    }
    attrs = [];
  });
  return { fields, errors };
}

/**
 * 解析多份 Rust 源码。
 * @param {Array<{file: string, text: string}>} sources
 * @returns {{structs: Array<{name: string, direction: string, fields: Array<{name: string, optional: boolean, type: string, source: string}>, file: string, line: number}>, errors: string[]}}
 */
export function parseMirrors(sources) {
  const errors = [];
  const blocks = [];
  for (const { file, text } of sources) {
    for (const b of scanBlocks(text, file)) {
      if (b.unterminated) { errors.push(`${file}:${b.line}：${b.name} 没有闭合的 }`); continue; }
      blocks.push(b);
    }
  }
  // known：类型名 → 引用它时该写的 TS。`null` = 结构体（直接用名字）。
  const known = new Map(blocks.map((b) => [b.name, null]));
  const enums = [];
  const seenEnum = new Set();
  // 枚举先解析：结构体字段可能引用它们，`tsType` 要能查到字面量联合
  for (const b of blocks.filter((x) => x.kind === "enum")) {
    if (seenEnum.has(b.name)) {
      errors.push(`${b.file}:${b.line}：${b.name} 被重复镜像（同一类型只能标一处）`);
      continue;
    }
    seenEnum.add(b.name);
    const { variants, errors: variantErrors } = parseEnumVariants(b);
    errors.push(...variantErrors);
    const ts = variants.length ? variants.map((v) => JSON.stringify(v.literal)).join(" | ") : "never";
    known.set(b.name, ts);
    enums.push({ name: b.name, variants, file: b.file, line: b.line });
  }
  const structs = [];
  const seen = new Set();
  for (const b of blocks.filter((x) => x.kind === "struct")) {
    if (seen.has(b.name)) {
      errors.push(`${b.file}:${b.line}：${b.name} 被重复镜像（同一类型只能标一处）`);
      continue;
    }
    seen.add(b.name);
    const { fields, errors: fieldErrors } = parseFields(b, known);
    errors.push(...fieldErrors);
    structs.push({ name: b.name, direction: b.direction, fields, file: b.file, line: b.line });
  }
  return { structs, enums, errors };
}

/** 生成 TS 源码。同样的输入必须产出同样的字节，`--check` 才能直接比文本。 */
export function renderBindings(structs, enums = []) {
  const head = [
    "/**",
    " * ⚠️ 本文件由 `scripts/gen-bindings.mjs` 从 Rust 源码生成，**不要手改**。",
    " *",
    " * 来源：`src-tauri/src/**` 里带 `// @ts-mirror` 标记的结构体/枚举。改了 Rust 字段就重跑：",
    " *   npm run bindings:generate",
    " *",
    " * 与手写类型的相等性由 `src/lib/bindings.check.ts` 在 tsc 阶段钉住——",
    " * 那条断言就是「改一个 Rust 字段，`tsc` 当场红」的落点。",
    " */",
    "",
  ];
  const enumBlocks = enums.map((e) => {
    const union = e.variants.length ? e.variants.map((v) => JSON.stringify(v.literal)).join(" | ") : "never";
    return [`/** ${e.file}:${e.line} · 枚举 */`, `export type ${e.name} = ${union};`, ""].join("\n");
  });
  const blocks = structs.map((s) => {
    const lines = s.fields.map((f) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(f.name) ? f.name : JSON.stringify(f.name);
      return `  ${name}${f.optional ? "?" : ""}: ${f.type};`;
    });
    return [`/** ${s.file}:${s.line} · ${s.direction} */`, `export interface ${s.name} {`, ...lines, "}", ""].join("\n");
  });
  return head.join("\n") + enumBlocks.join("\n") + blocks.join("\n");
}
