// SQL 格式化偏好：关键字大小写 / 缩进风格 / 宽度 / 方言覆盖 / 长表达式宽度 / 语句间空行。
//
// 与 `lib/editorPrefs` 同一套范式（localStorage + 事件订阅，`useSyncExternalStore`）：
// 这些是**本机排版习惯**，不进 AppConfig 导入导出，换台机器不该被同事的偏好覆盖。
// 格式化在非 React 的 Monaco 动作里触发，所以除 React 钩子外还暴露同步读取。
import { useSyncExternalStore } from "react";
import type { FormatOptions, IndentStyle, KeywordCase, LogicalOperatorNewline, SqlLanguage } from "sql-formatter";

const KEY = "ncforge-sql-format-prefs";

/** `auto` = 跟随连接 JDBC URL 推断方言；其余为手动覆盖。 */
export type SqlDialect = "auto" | SqlLanguage;

export interface SqlFormatPrefs {
  keywordCase: KeywordCase;
  indentStyle: IndentStyle;
  tabWidth: number;
  dialect: SqlDialect;
  expressionWidth: number;
  linesBetweenQueries: number;
  logicalOperatorNewline: LogicalOperatorNewline;
}

export const DEFAULT_SQL_FORMAT: SqlFormatPrefs = {
  keywordCase: "preserve",
  indentStyle: "standard",
  tabWidth: 2,
  dialect: "auto",
  expressionWidth: 50,
  linesBetweenQueries: 1,
  logicalOperatorNewline: "before",
};

/** 设置页的方言选项。顺序固定，`auto` 恒在首位。 */
export const SQL_DIALECTS: { value: SqlDialect; label: string }[] = [
  { value: "auto", label: "跟随连接" },
  { value: "plsql", label: "Oracle" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "tsql", label: "SQL Server" },
  { value: "db2", label: "DB2" },
  { value: "sqlite", label: "SQLite" },
  { value: "sql", label: "标准 SQL" },
];

const KEYWORD_CASES: KeywordCase[] = ["preserve", "upper", "lower"];
const INDENT_STYLES: IndentStyle[] = ["standard", "tabularLeft", "tabularRight"];
const LOGICAL_NEWLINES: LogicalOperatorNewline[] = ["before", "after"];
const DIALECTS: SqlDialect[] = SQL_DIALECTS.map((item) => item.value);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** 逐字段归一化：老版本/手改的 JSON 缺字段或越界时回落默认，而不是整体失效。 */
function normalize(raw: Partial<SqlFormatPrefs>): SqlFormatPrefs {
  return {
    keywordCase: oneOf(raw.keywordCase, KEYWORD_CASES, DEFAULT_SQL_FORMAT.keywordCase),
    indentStyle: oneOf(raw.indentStyle, INDENT_STYLES, DEFAULT_SQL_FORMAT.indentStyle),
    tabWidth: integer(raw.tabWidth, DEFAULT_SQL_FORMAT.tabWidth, 1, 8),
    dialect: oneOf(raw.dialect, DIALECTS, DEFAULT_SQL_FORMAT.dialect),
    expressionWidth: integer(raw.expressionWidth, DEFAULT_SQL_FORMAT.expressionWidth, 1, 200),
    linesBetweenQueries: integer(raw.linesBetweenQueries, DEFAULT_SQL_FORMAT.linesBetweenQueries, 0, 5),
    logicalOperatorNewline: oneOf(raw.logicalOperatorNewline, LOGICAL_NEWLINES, DEFAULT_SQL_FORMAT.logicalOperatorNewline),
  };
}

let cache: SqlFormatPrefs = load();
let lastWriteSucceeded = true;
const listeners = new Set<() => void>();

function load(): SqlFormatPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw) as Partial<SqlFormatPrefs>) : { ...DEFAULT_SQL_FORMAT };
  } catch {
    return { ...DEFAULT_SQL_FORMAT };
  }
}

export function getSqlFormatPrefs(): SqlFormatPrefs {
  return cache;
}

export function setSqlFormatPrefs(patch: Partial<SqlFormatPrefs>): boolean {
  const next = normalize({ ...cache, ...patch });
  const changed = (Object.keys(patch) as (keyof SqlFormatPrefs)[]).some((key) => cache[key] !== next[key]);
  // 与 editorPrefs 一致：值没变且上次写成功时保持无操作；写失败后允许重试同一值。
  if (!changed && lastWriteSucceeded) return true;
  cache = next;
  let stored = true;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    stored = false;
  }
  if (changed) listeners.forEach((listener) => listener());
  lastWriteSucceeded = stored;
  return stored;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** React 侧订阅（设置页用）。 */
export function useSqlFormatPrefs(): SqlFormatPrefs {
  return useSyncExternalStore(subscribe, getSqlFormatPrefs, getSqlFormatPrefs);
}

/** 传给 sql-formatter 的选项子集；方言由调用方按连接推断后单独传入。 */
export function formatOptionsOf(prefs: SqlFormatPrefs): Partial<FormatOptions> {
  return {
    keywordCase: prefs.keywordCase,
    indentStyle: prefs.indentStyle,
    tabWidth: prefs.tabWidth,
    expressionWidth: prefs.expressionWidth,
    linesBetweenQueries: prefs.linesBetweenQueries,
    logicalOperatorNewline: prefs.logicalOperatorNewline,
  };
}
