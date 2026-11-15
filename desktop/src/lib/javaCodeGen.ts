// Java 样板代码生成：getter / setter / 构造器 / toString / equals / hashCode。
//
// 为什么不走 jdt.ls：它不提供代码生成（LSP 标准没有这个能力），而且红线是它不能写用户文件。
// 这里全部是纯函数：输入字段清单与缩进，输出待插入的文本，由编辑器插入、用户自己保存。
//
// 命名遵循 JavaBeans：boolean 字段的读法用 `isXxx`，其余 `getXxx`。
import type { JavaField, JavaMethod } from "./javaModel";

export type GenKind =
  | "constructor"
  | "getters"
  | "setters"
  | "toString"
  | "equals"
  | "hashCode";

export interface GenOptions {
  fields: JavaField[];
  className: string;
  /** 缩进单位（NC 工程是 `\t`）。 */
  indent: string;
  methods?: JavaMethod[];
  baseIndent?: string;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const isBoolean = (t: string) => t === "boolean";

/** 泛型擦除后相同的参数不能重复生成；参数名不参与 Java 方法签名。 */
function parameterType(parameter: string): string {
  let type = parameter.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, "").replace(/\bfinal\s+/g, "");
  while (/<[^<>]*>/.test(type)) type = type.replace(/<[^<>]*>/g, "");
  return type.replace(/\s+[\w$]+(?=\s*(?:\[\])?\s*$)/, "")
    .replace(/\b(?:[a-z][\w$]*\.)+/g, "").replace(/\.\.\./g, "[]").replace(/\s/g, "");
}

function exists(o: GenOptions, name: string, types: string[] = []): boolean {
  return !!o.methods?.some(method => method.name === name && method.params.length === types.length
    && method.params.every((param, i) => parameterType(param) === parameterType(`${types[i]} value`)));
}

function getterName(f: JavaField): string {
  // JavaBeans 保留 URL 一类首两字母大写名称；primitive boolean 的 isReady 不应变成 isIsReady。
  return isBoolean(f.type) && /^is[A-Z]/.test(f.name) ? f.name : `${isBoolean(f.type) ? "is" : "get"}${cap(f.name)}`;
}
const setterName = (f: JavaField) => `set${isBoolean(f.type) && /^is[A-Z]/.test(f.name) ? f.name.slice(2) : cap(f.name)}`;
const constructorFields = (o: GenOptions) => o.fields.filter(f => !f.isStatic && !(f.isFinal && f.isInitialized));

/** 生成器实际会用到的字段：static 也参与（静态工厂方法 / toString 需要它）。 */
function settable(f: JavaField): boolean {
  return !f.isFinal && !f.isStatic;
}

function getter(f: JavaField, o: GenOptions): string {
  const name = getterName(f);
  if (exists(o, name)) return "";
  const mod = f.isStatic ? "public static" : "public";
  return `${o.indent}${mod} ${f.type} ${name}() {\n${o.indent}${o.indent}return ${f.name};\n${o.indent}}\n`;
}

function setter(f: JavaField, o: GenOptions): string {
  if (exists(o, setterName(f), [f.type])) return "";
  const mod = f.isStatic ? "public static" : "public";
  return `${o.indent}${mod} void ${setterName(f)}(${f.type} ${f.name}) {\n${o.indent}${o.indent}this.${f.name} = ${f.name};\n${o.indent}}\n`;
}

function constructor(o: GenOptions): string {
  const fs = constructorFields(o);
  if (fs.length === 0) return "";
  if (exists(o, o.className, fs.map(f => f.type))) return "";
  const params = fs.map((f) => `${f.type} ${f.name}`).join(", ");
  const body = fs.map((f) => `${o.indent}${o.indent}this.${f.name} = ${f.name};\n`).join("");
  return `${o.indent}public ${o.className}(${params}) {\n${body}${o.indent}}\n`;
}

function toStr(o: GenOptions): string {
  if (exists(o, "toString")) return "";
  const fs = o.fields;
  if (fs.length === 0) {
    return `${o.indent}@Override\n${o.indent}public String toString() {\n${o.indent}${o.indent}return "${o.className}{}";\n${o.indent}}\n`;
  }
  // 与 IDEA 默认模板一致：`类名{字段=值, 字段=值}`。
  // 每行必须以 `+` 结尾（Java 不允许在操作数后面换行续写），最后一行收尾 `+ '}'`。
  const body = fs
    .map((f, i) => {
      const label = i === 0 ? `${f.name}="` : `, ${f.name}="`;
      const value = f.type.includes("[]") ? `java.util.Arrays.${(f.type.match(/\[\s*\]/g)?.length ?? 0) > 1 ? "deepToString" : "toString"}(${f.name})` : f.name;
      return `${o.indent}${o.indent}${o.indent}"${label} + ${value} +`;
    })
    .join("\n");
  return [
    `${o.indent}@Override`,
    `${o.indent}public String toString() {`,
    `${o.indent}${o.indent}return "${o.className}{" +`,
    body,
    `${o.indent}${o.indent}${o.indent}'}';`,
    `${o.indent}}`,
    "",
  ].join("\n");
}

function equals(o: GenOptions): string {
  if (exists(o, "equals", ["Object"]) || exists(o, "equals", ["java.lang.Object"])) return "";
  const fs = o.fields.filter((f) => !f.isStatic);
  // 逐字段写 Objects.equals 而不是 Objects.equals(a, b) 一次比多个：
  // 后者没有这个重载，会退化成 Object[].equals 引用比较，永远 false。
  const cond = fs.length
    ? fs
        .map((f) => `java.util.Objects.${f.type.includes("[]") ? "deepEquals" : "equals"}(${f.name}, that.${f.name})`)
        .join(`\n${o.indent}${o.indent}${o.indent}&& `)
    : "true";
  return [
    `${o.indent}@Override`,
    `${o.indent}public boolean equals(Object o) {`,
    `${o.indent}${o.indent}if (this == o) {`,
    `${o.indent}${o.indent}${o.indent}return true;`,
    `${o.indent}${o.indent}}`,
    `${o.indent}${o.indent}if (o == null || getClass() != o.getClass()) {`,
    `${o.indent}${o.indent}${o.indent}return false;`,
    `${o.indent}${o.indent}}`,
    `${o.indent}${o.indent}${o.className} that = (${o.className}) o;`,
    `${o.indent}${o.indent}return ${cond};`,
    `${o.indent}}`,
    "",
  ].join("\n");
}

function hashCode(o: GenOptions): string {
  if (exists(o, "hashCode")) return "";
  const fs = o.fields.filter((f) => !f.isStatic);
  if (fs.length === 0) {
    return `${o.indent}@Override\n${o.indent}public int hashCode() {\n${o.indent}${o.indent}return 1;\n${o.indent}}\n`;
  }
  return [
    `${o.indent}@Override`,
    `${o.indent}public int hashCode() {`,
    `${o.indent}${o.indent}return ${fs.some(f => f.type.includes("[]")) ? `java.util.Arrays.deepHashCode(new Object[] {${fs.map(f => f.name).join(", ")}})` : `java.util.Objects.hash(${fs.map(f => f.name).join(", ")})`};`,
    `${o.indent}}`,
    "",
  ].join("\n");
}

/** 生成一段代码（不带前后空行，调用方负责拼）。 */
export function generate(kind: GenKind, o: GenOptions): string {
  let text = "";
  switch (kind) {
    case "constructor":
      text = constructor(o); break;
    case "getters":
      text = o.fields.map((f) => getter(f, o)).join("\n"); break;
    case "setters":
      text = o.fields
        .filter(settable)
        .map((f) => setter(f, o))
        .join("\n"); break;
    case "toString":
      text = toStr(o); break;
    case "equals":
      text = equals(o); break;
    case "hashCode":
      text = hashCode(o); break;
  }
  return o.baseIndent ? text.split("\n").map(line => line ? o.baseIndent + line : line).join("\n") : text;
}

/** 这次选择里有没有「必须先有字段」的项（构造器 / getter / setter）。 */
export function needsFields(kind: GenKind): boolean {
  return kind === "constructor" || kind === "getters" || kind === "setters";
}

/** 一句给用户看的说明：为什么某项点了没生成（不是报错，是解释）。 */
export function skipReason(kind: GenKind, o: GenOptions): string | null {
  if (!needsFields(kind)) return generate(kind, o).trim() ? null : "对应方法已存在";
  if (kind === "setters") {
    if (o.fields.length === 0) return "类里没有字段";
    if (o.fields.every((f) => !settable(f))) return "字段都是 static 或 final，不需要 setter";
    return generate(kind, o).trim() ? null : "对应 setter 已存在";
  }
  if (o.fields.length === 0) return "类里没有字段";
  return generate(kind, o).trim() ? null : kind === "constructor" ? "构造器已存在或没有可赋值字段" : "对应 getter 已存在";
}

/** 待插入文本的收尾：保证与上一个成员之间有一个空行。 */
export function joinGenerated(parts: string[]): string {
  const list = parts.filter((p) => p.trim());
  if (list.length === 0) return "";
  return `\n${list.join("\n")}`;
}

/** 生成预览用的完整清单（对话框里显示「将生成 7 个方法」）。 */
export function summarize(kinds: GenKind[], o: GenOptions): string {
  const parts: string[] = [];
  for (const k of kinds) {
    if (skipReason(k, o)) continue;
    switch (k) {
      case "constructor":
        parts.push("构造器");
        break;
      case "getters":
        parts.push(`${o.fields.filter(f => getter(f, o)).length} 个 getter`);
        break;
      case "setters":
        parts.push(`${o.fields.filter(f => settable(f) && setter(f, o)).length} 个 setter`);
        break;
      case "toString":
        parts.push("toString");
        break;
      case "equals":
        parts.push("equals");
        break;
      case "hashCode":
        parts.push("hashCode");
        break;
    }
  }
  return parts.join(" + ");
}
