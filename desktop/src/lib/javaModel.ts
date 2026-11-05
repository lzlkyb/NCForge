// 极简 Java 源码模型：只抽「生成代码」需要的字段与方法清单。
//
// 为什么不引入真正的解析器：完整 AST（javaparser 之类）体积上百万字节，且与
// 「单文件 ≤300 行」的门禁不搭。这里的精度要求很低——列出类体第一层的字段及其类型，
// 供 getter / setter / 构造器 / toString 使用。为此做了两件事：
//   1. 把注释与字符串字面量整段抹成空格（保留换行），避免 `"x;"` 里的分号骗过扫描；
//   2. 用花括号深度定位「类体第一层」，嵌套类、方法体里的局部变量都不会被当成字段。

export interface JavaField {
  name: string;
  /** 原样类型文本，可能带泛型（`List<String>`）。 */
  type: string;
  isStatic: boolean;
  isFinal: boolean;
}

export interface JavaMethod {
  name: string;
  returnType: string;
  /** 原始参数文本（每项已 trim）。`null` 表示解析失败。 */
  params: string[];
}

export interface JavaType {
  kind: "class" | "interface" | "enum" | "record";
  name: string;
  packageName: string | null;
  fields: JavaField[];
  methods: JavaMethod[];
  /** 类体最后一个 `}` 的行号（0 基）。找不到时为 -1。 */
  bodyEndLine: number;
  /** 成员缩进单位：NC 工程是制表符，但别的工程可能用空格。 */
  indent: string;
}

const MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "final",
  "transient",
  "volatile",
  "synchronized",
  "native",
  "abstract",
  "default",
  "strictfp",
  "sealed",
  "non-sealed",
]);

/**
 * 把注释与字符串/字符字面量替换成空格（换行原样保留）。
 *
 * 保留换行是硬要求：行号、花括号深度都靠它对齐，少一行就会把字段算错位置。
 */
export function blankLiterals(text: string): string {
  const out: string[] = [];
  let i = 0;
  type State = "code" | "line" | "block" | "str" | "chr";
  let st: State = "code";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (st === "code") {
      if (c === "/" && n === "/") {
        st = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        st = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === '"') {
        st = "str";
        out.push(" ");
        i += 1;
        continue;
      }
      if (c === "'") {
        st = "chr";
        out.push(" ");
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (c === "\n") {
      // 行注释遇换行结束；其它状态原样保留换行（不让字符串跨行把后续行吞掉）
      if (st === "line") st = "code";
      out.push("\n");
      i += 1;
      continue;
    }
    if (st === "block" && c === "*" && n === "/") {
      st = "code";
      out.push("  ");
      i += 2;
      continue;
    }
    if ((st === "str" || st === "chr") && c === "\\") {
      out.push("  ");
      i += 2;
      continue;
    }
    if (st === "str" && c === '"') {
      st = "code";
      out.push(" ");
      i += 1;
      continue;
    }
    if (st === "chr" && c === "'") {
      st = "code";
      out.push(" ");
      i += 1;
      continue;
    }
    out.push(" ");
    i += 1;
  }
  return out.join("");
}

/** 从候选行里猜缩进单位（制表符优先：NC 源码几乎全是 Tab）。 */
function detectIndent(lines: string[], classLine: number): string {
  for (let i = classLine + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s+)\S/);
    if (!m) continue;
    return m[1].includes("\t") ? "\t" : m[1].slice(-4) || "    ";
  }
  return "\t";
}

/** 去掉注解（`@Override`、`@SuppressWarnings("x")`）与修饰符，返回剩余部分。 */
function stripAnnotations(s: string): string {
  let out = s;
  // 逐条剥：注解可能带括号参数，参数里可能有嵌套括号
  for (;;) {
    const at = out.indexOf("@");
    if (at < 0 || /\w/.test(out.slice(0, at))) return out;
    let j = at + 1;
    while (j < out.length && /[\w.]/.test(out[j])) j += 1;
    if (out[j] === "(") {
      let depth = 0;
      for (; j < out.length; j += 1) {
        if (out[j] === "(") depth += 1;
        else if (out[j] === ")") {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }
    }
    out = out.slice(0, at) + out.slice(j);
  }
}

/** `Map<String, Integer> cache` → `{ type: "Map<String, Integer>", name: "cache" }`。 */
function splitTypeAndName(decl: string): { type: string; name: string } | null {
  const s = decl.trim().replace(/\s+/g, " ");
  if (!s) return null;
  const m = s.match(/^(.*?[\w>\]])?\s*([A-Za-z_$][\w$]*)$/);
  if (!m) return null;
  const name = m[2];
  const type = (m[1] ?? "").trim();
  return type ? { type, name } : null;
}

/** 顶层逗号切分（泛型里的逗号不算）。 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(" || ch === "[") depth += 1;
    else if (ch === ">" || ch === ")" || ch === "]") depth -= 1;
    if (ch === sep && depth <= 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseField(stmt: string): JavaField | null {
  let s = stripAnnotations(stmt).trim();
  const mods: string[] = [];
  for (;;) {
    const m = s.match(/^([\w-]+)\s+/);
    if (!m || !MODIFIERS.has(m[1])) break;
    mods.push(m[1]);
    s = s.slice(m[0].length);
  }
  // 去掉初始化表达式（找顶层 `=`）
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "<") depth += 1;
    else if (s[i] === ">") depth -= 1;
    else if (s[i] === "=" && depth === 0) {
      cut = i;
      break;
    }
  }
  if (cut >= 0) s = s.slice(0, cut);
  const tn = splitTypeAndName(s);
  if (!tn) return null;
  // 类型里带空格又不像泛型时（`String [] x` 之类）放行；但明显是语句的排除掉
  if (/[;{}]/.test(tn.type)) return null;
  if (tn.name === "return" || tn.name === "new") return null;
  return { name: tn.name, type: tn.type, isStatic: mods.includes("static"), isFinal: mods.includes("final") };
}

function parseMethodHeader(header: string): JavaMethod | null {
  const s = stripAnnotations(header).trim().replace(/\s+/g, " ");
  const lp = s.indexOf("(");
  if (lp < 0) return null;
  let depth = 0;
  let rp = -1;
  for (let i = lp; i < s.length; i += 1) {
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        rp = i;
        break;
      }
    }
  }
  if (rp < 0) return null;
  const before = s.slice(0, lp).trim();
  const nm = before.match(/([A-Za-z_$][\w$]*)$/);
  if (!nm) return null;
  const name = nm[1];
  if (name === "if" || name === "for" || name === "while" || name === "switch" || name === "catch" || name === "new") {
    return null;
  }
  let rest = before.slice(0, before.length - name.length).trim();
  for (let m = rest.match(/^([\w-]+)\s+/); m && MODIFIERS.has(m[1]); m = rest.match(/^([\w-]+)\s+/)) {
    rest = rest.slice(m[0].length);
  }
  const params = splitTopLevel(s.slice(lp + 1, rp), ",");
  return { name, returnType: rest || "void", params };
}

export function javaEnumConstant(header: string) {
  const clean = stripAnnotations(header).trimStart();
  const name = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(clean)?.[0];
  return name ? { name, offset: header.indexOf(clean) } : null;
}

/** Read a declaration header from a class body without treating field initializers as methods. */
export function javaMemberHeader(header: string, owner: string) {
  const clean = stripAnnotations(header).trim();
  const signature = splitTopLevel(clean, "=")[0] ?? "";
  const prefix = header.indexOf(clean);
  const open = signature.indexOf("(");
  if (open >= 0) {
    const method = parseMethodHeader(signature);
    if (!method) return null;
    const nameOffset = signature.slice(0, open).lastIndexOf(method.name);
    const beforeName = signature.slice(0, nameOffset).trim().split(/\s+/).filter(word => !MODIFIERS.has(word)).join(" ");
    const constructor = method.name === owner && (!beforeName || /^<.*>$/.test(beforeName));
    return {
      label: `${method.name}(${method.params.join(", ")})`,
      offset: prefix + nameOffset,
      kind: constructor ? 9 : 6,
    };
  }
  const field = parseField(signature);
  if (!field || /,\s*[^<>]*$/.test(field.type)) return null;
  return { label: field.name, offset: prefix + signature.lastIndexOf(field.name), kind: field.isStatic && field.isFinal ? 14 : 8 };
}

/**
 * 解析一段 Java 源码。
 *
 * 只采集**类体第一层**（花括号深度恰为 1）的成员：嵌套类里的字段天然在深度 2，
 * 不会被当成外层字段；方法体里的局部变量同理。
 */
export function parseJava(text: string): JavaType | null {
  const code = blankLiterals(text);
  const lines = code.split("\n");
  const pkg = text.match(/^\s*package\s+([\w.]+)\s*;/m);

  let declLine = -1;
  let kind: JavaType["kind"] = "class";
  let name = "";
  let bodyLine = -1;
  let bodyCol = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      kind = m[1] as JavaType["kind"];
      name = m[2];
      declLine = i;
      // 类体 `{` 可能在同一个文件后面的任意位置（`implements X,` 换行）
      for (let k = i; k < lines.length; k += 1) {
        const at = lines[k].indexOf("{");
        if (at >= 0) {
          bodyLine = k;
          bodyCol = at;
          break;
        }
      }
      break;
    }
  }
  if (declLine < 0 || bodyLine < 0) return null;

  const fields: JavaField[] = [];
  const methods: JavaMethod[] = [];
  let depth = 0;
  let buf = "";
  let bodyEndLine = -1;
  let started = false;

  const flushField = () => {
    const stmt = buf.trim();
    buf = "";
    if (!stmt) return;
    if (stmt.includes("(")) {
      const m = parseMethodHeader(stmt);
      if (m) methods.push(m);
      return;
    }
    const f = parseField(stmt);
    if (f) fields.push(f);
  };

  for (let i = declLine; i < lines.length; i += 1) {
    const line = lines[i];
    const from = i === bodyLine ? bodyCol : 0;
    for (let j = from; j < line.length; j += 1) {
      const ch = line[j];
      if (!started) {
        if (ch === "{") {
          started = true;
          depth = 1;
        }
        continue;
      }
      if (ch === "{") {
        if (depth === 1) {
          // 成员自己的 `{`：方法头 / 初始化块 / 嵌套类型，标题到此为止
          const head = buf.trim();
          buf = "";
          if (head && head.includes("(") && !/^\s*(static\s*)?\{/.test(head)) {
            const m = parseMethodHeader(head);
            if (m) methods.push(m);
          } else if (head && /\b(class|interface|enum|record)\b/.test(head)) {
            // 嵌套类型整体跳过（它的成员在 depth 2）
            buf = "";
          }
        }
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          bodyEndLine = i;
          started = false;
          break;
        }
        continue;
      }
      if (depth === 1) {
        if (ch === ";") {
          flushField();
          continue;
        }
        buf += ch;
      }
    }
    if (depth === 0 && bodyEndLine >= 0) break;
  }

  return {
    kind,
    name,
    packageName: pkg ? pkg[1] : null,
    fields,
    methods,
    bodyEndLine,
    indent: detectIndent(lines, declLine),
  };
}

/** 当前文件的缩进单位（生成代码与插入位置都用它）。 */
export function indentUnitOf(text: string): string {
  const m = text.match(/^\t/m);
  return m ? "\t" : "    ";
}
