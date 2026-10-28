import { invoke } from "./tauri";

// 与 Rust `workspace.rs` 的 serde 结构一一对应（camelCase，枚举用字面值）。
export type TextEncoding = "UTF-8" | "GBK";
export type Eol = "LF" | "CRLF" | "MIXED";

export interface DirItem {
  name: string;
  isDir: boolean;
  size: number;
}

export interface FileContent {
  /** 给编辑器的文本：非 MIXED 时只含 `\n`。 */
  text: string;
  encoding: TextEncoding;
  hasBom: boolean;
  eol: Eol;
  /** 按检测编码/换行重建字节是否与磁盘一致；为 false 时保存会改动原文件，必须只读。 */
  lossless: boolean;
  size: number;
  mtimeMs: number;
}

export interface WriteArgs {
  path: string;
  text: string;
  encoding: TextEncoding;
  hasBom: boolean;
  eol: Eol;
  /** 读取时记下的修改时间；null = 不检查（用户确认覆盖）。 */
  expectedMtimeMs: number | null;
}

export const getWorkspace = () => invoke<string | null>("get_workspace");
export const setWorkspace = (path: string) => invoke<string>("set_workspace", { path });
export const listDir = (path: string) => invoke<DirItem[]>("fs_list_dir", { path });
export const readFile = (path: string) => invoke<FileContent>("fs_read_file", { path });
// 类型断言：WriteArgs 是具名接口，没有索引签名，不能直接赋给 Record<string, unknown>。
export const writeFile = (args: WriteArgs) =>
  invoke<number>("fs_write_file", args as unknown as Record<string, unknown>);

export type NewEntryKind = "file" | "dir";

/** 新建文件/文件夹，返回新条目的完整路径。 */
export const createEntry = (parent: string, name: string, kind: NewEntryKind) =>
  invoke<string>("fs_create", { parent, name, kind });

/** 同目录内改名，返回新路径。 */
export const renameEntry = (path: string, newName: string) =>
  invoke<string>("fs_rename", { path, newName });

/** 删除文件/文件夹；文件夹必须 recursive（先调 countFiles 让用户看清删多少）。 */
export const deleteEntry = (path: string, recursive: boolean) =>
  invoke<void>("fs_delete", { path, recursive });

/** 目录下的文件数（递归，跳过 .svn/.git）；传文件返回 1。 */
export const countFiles = (path: string) => invoke<number>("fs_count_files", { path });

/**
 * 一个编码标记：磁盘上是 UTF-8，但 Eclipse 不会按 UTF-8 读。
 *
 * 只针对 `.java`：这类文件用 Eclipse 编出来的 class 里中文字符串常量是乱码，
 * 而工作台按内容探测编码、产物是对的。
 */
export interface EncodingMark {
  path: string;
  /** 偏好里登记的编码；null = 没登记，Eclipse 用工程默认（GBK）。 */
  registered: string | null;
}

/** 批量查编码标记；非 .java 的路径后端直接跳过，返回里没有它们。 */
export const encodingMarks = (paths: string[]) =>
  invoke<EncodingMark[]>("fs_encoding_marks", { paths });

/** 后端保存冲突的错误前缀（磁盘文件已被其他程序修改）。 */
export const isConflictError = (e: unknown) => String(e).startsWith("CONFLICT");

/** 工作区路径是 Windows 风格，给后端的路径统一用反斜杠拼接。 */
export function joinPath(parent: string, name: string): string {
  return parent.endsWith("\\") ? parent + name : `${parent}\\${name}`;
}

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? path : path.slice(i + 1);
}

/** 父目录（工作区根这类没有分隔符的返回空串）。 */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * 把 `path` 里属于 `from` 的那一段换成 `to`。
 *
 * 目录改名后，树上展开态、目录缓存、已打开的标签都还记着旧前缀，统一用这个改。
 * 比较时忽略大小写——Windows 路径不分大小写，而重命名恰恰可能只改大小写。
 */
export function remapPath(path: string, from: string, to: string): string {
  const lower = path.toLowerCase();
  const fromLower = from.toLowerCase();
  if (lower === fromLower) return to;
  if (lower.startsWith(fromLower + "\\")) return to + path.slice(from.length);
  return path;
}

/** 名字里不允许的字符（与后端 `validate_entry_name` 同一套规则）。 */
const BAD_NAME_CHARS = /[\\/:*?"<>|]/;
const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * 即时校验：规则与后端 `validate_entry_name` 一致，合法返回 null。
 *
 * 同时挡在前面能省掉一次 IPC 往返；但后端仍会再校验一遍，两边都不能省。
 */
export function validateEntryName(name: string): string | null {
  if (!name.trim()) return "名字不能为空";
  if (name.trim() !== name) return "名字首尾不能有空格";
  const bad = name.match(BAD_NAME_CHARS);
  if (bad) return `名字不能包含 ${bad[0]}（\\ / : * ? " < > |）`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "名字不能包含控制字符";
  if (name.endsWith(".")) return "名字不能以点结尾";
  if ([...name].length > 120) return "名字太长";
  const stem = name.split(".")[0];
  if (RESERVED_NAMES.has(stem.toUpperCase())) return `${stem} 是 Windows 保留名，不能用作文件名`;
  return null;
}

/** 拆主名与扩展名，重命名时只选中主名（`.gitignore` 这类点开头的整个算主名）。 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

/** 按扩展名选 Monaco 语言 id；认不出的按纯文本。NC 的 upm/bmf/xsd 等都是 XML。 */
export function languageOf(path: string): string {
  const ext = baseName(path).split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "java":
      return "java";
    case "xml":
    case "upm":
    case "bmf":
    case "xsd":
    case "wsdl":
    case "xsl":
    case "project":
    case "classpath":
      return "xml";
    case "sql":
      return "sql";
    case "js":
      return "javascript";
    case "ts":
      return "typescript";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "properties":
    case "ini":
    case "prefs":
      return "ini";
    case "md":
      return "markdown";
    default:
      return "plaintext";
  }
}
