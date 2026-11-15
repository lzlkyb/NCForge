import type { SqlLanguage } from "sql-formatter";
import { snippetEscape } from "./sqlTemplates";

export interface SqlTimePreset { operator: string; label: string; insertText: string; suffix: string; hint: string }
interface TimeType { cast: string; kind: "date" | "timestamp" | "zone" | "local-zone"; precision: string }
interface CalendarBounds { today: string; tomorrow: string; month: string; nextMonth: string; lastMonth: string; sixDaysAgo: string }

function timestampType(type: string, dialect: SqlLanguage): TimeType | null {
  const match = /^TIMESTAMP(?:\s*\(\s*(\d+)\s*\))?(?: (WITHOUT TIME ZONE|WITH TIME ZONE|WITH LOCAL TIME ZONE))?$/.exec(type);
  const pgAlias = dialect === "postgresql" && /^TIMESTAMPTZ(?:\s*\(\s*(\d+)\s*\))?$/.exec(type);
  if (!match && !pgAlias) return null;
  const digits = match?.[1] ?? (pgAlias ? pgAlias[1] : undefined), zone = match?.[2] ?? (pgAlias ? "WITH TIME ZONE" : "");
  const maxPrecision = dialect === "plsql" ? 9 : dialect === "db2" ? 12 : 6;
  if (digits !== undefined && Number(digits) > maxPrecision) return null;
  const precision = digits === undefined ? "" : `(${Number(digits)})`;
  if (dialect === "plsql" && zone === "WITHOUT TIME ZONE" || dialect === "postgresql" && zone === "WITH LOCAL TIME ZONE" || dialect === "db2" && zone) return null;
  const kind = zone === "WITH LOCAL TIME ZONE" ? "local-zone" : zone === "WITH TIME ZONE" ? "zone" : "timestamp";
  const qualifier = dialect === "postgresql" ? kind === "zone" ? " WITH TIME ZONE" : " WITHOUT TIME ZONE" : zone ? ` ${zone}` : "";
  return { cast: `TIMESTAMP${precision}${qualifier}`, kind, precision };
}

function timeType(type: string, dialect: SqlLanguage): TimeType | null {
  // SQLite declarations do not prove the value's ISO / Unix / Julian encoding; generic SQL has no known engine.
  if (!["plsql", "postgresql", "tsql", "mysql", "mariadb", "db2"].includes(dialect)) return null;
  const t = type.trim().replace(/\s+/g, " ").toUpperCase();
  if (t === "DATE") return { cast: "DATE", kind: "date", precision: "" };
  if (["plsql", "postgresql", "db2"].includes(dialect)) return timestampType(t, dialect);
  if (dialect === "tsql") {
    if (t === "DATETIME" || t === "SMALLDATETIME") return { cast: t, kind: "timestamp", precision: "" };
    const match = /^DATETIME2(?:\s*\(\s*(\d+)\s*\))?$/.exec(t);
    if (!match || match[1] !== undefined && Number(match[1]) > 7) return null;
    // TIMESTAMP is rowversion; DATETIMEOFFSET needs a named time zone to define DST-safe local calendar days.
    return { cast: `DATETIME2${match[1] === undefined ? "" : `(${Number(match[1])})`}`, kind: "timestamp", precision: "" };
  }
  const match = /^(DATETIME|TIMESTAMP)(?:\s*\(\s*(\d+)\s*\))?$/.exec(t);
  if (!match || match[2] !== undefined && Number(match[2]) > 6) return null;
  // MySQL/MariaDB CAST has no portable TIMESTAMP target; comparison uses the column's session-zone semantics.
  return { cast: `DATETIME${match[2] === undefined ? "" : `(${Number(match[2])})`}`, kind: "timestamp", precision: "" };
}

function calendarBounds(dialect: SqlLanguage): CalendarBounds {
  if (dialect === "plsql") {
    const today = "TRUNC(CURRENT_DATE)", month = "TRUNC(CURRENT_DATE, 'MM')";
    // Interval arithmetic from the first day keeps Gregorian month boundaries even with a non-Gregorian NLS_CALENDAR.
    return { today, tomorrow: `${today} + 1`, sixDaysAgo: `${today} - 6`, month,
      nextMonth: `${month} + INTERVAL '1' MONTH`, lastMonth: `${month} - INTERVAL '1' MONTH` };
  }
  if (dialect === "postgresql") {
    const today = "CURRENT_DATE", month = "DATE_TRUNC('month', CAST(CURRENT_DATE AS TIMESTAMP))";
    // Convert each local date to the target type separately: a DST day need not last 24 hours.
    return { today, tomorrow: `${today} + 1`, sixDaysAgo: `${today} - 6`, month,
      nextMonth: `${month} + INTERVAL '1 month'`, lastMonth: `${month} - INTERVAL '1 month'` };
  }
  if (dialect === "tsql") {
    const today = "CAST(GETDATE() AS DATE)", month = `DATEADD(DAY, 1 - DAY(${today}), ${today})`;
    return { today, tomorrow: `DATEADD(DAY, 1, ${today})`, sixDaysAgo: `DATEADD(DAY, -6, ${today})`, month,
      nextMonth: `DATEADD(MONTH, 1, ${month})`, lastMonth: `DATEADD(MONTH, -1, ${month})` };
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    const today = "CURDATE()", month = "DATE_SUB(CURDATE(), INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY)";
    return { today, tomorrow: `DATE_ADD(${today}, INTERVAL 1 DAY)`, sixDaysAgo: `DATE_SUB(${today}, INTERVAL 6 DAY)`, month,
      nextMonth: `DATE_ADD(${month}, INTERVAL 1 MONTH)`, lastMonth: `DATE_SUB(${month}, INTERVAL 1 MONTH)` };
  }
  const today = "CURRENT DATE", month = "CURRENT DATE - (DAY(CURRENT DATE) - 1) DAYS";
  return { today, tomorrow: `${today} + 1 DAY`, sixDaysAgo: `${today} - 6 DAYS`, month,
    nextMonth: `(${month}) + 1 MONTH`, lastMonth: `(${month}) - 1 MONTH` };
}

function typedBound(bound: string, type: TimeType, dialect: SqlLanguage): string {
  if (dialect === "plsql" && (type.kind === "zone" || type.kind === "local-zone")) {
    const zoned = `FROM_TZ(CAST(${bound} AS TIMESTAMP${type.precision}), SESSIONTIMEZONE)`;
    return type.kind === "local-zone" ? `CAST(${zoned} AS ${type.cast})` : zoned;
  }
  if (type.kind === "date" && !["plsql", "postgresql"].includes(dialect)) return bound;
  return `CAST(${bound} AS ${type.cast})`;
}

/** identifier is already rendered with sqlIdentifier (and an optional alias), as in sqlPredicates. */
export function sqlTimePresets(identifier: string, type: string, dialect: SqlLanguage, upper: boolean): SqlTimePreset[] {
  const temporal = timeType(type, dialect);
  if (!temporal) return [];
  const bounds = calendarBounds(dialect), id = snippetEscape(identifier);
  const clockHint = dialect === "tsql" ? "按数据库服务器当前日期和服务器本地时区" : dialect === "db2" ? "按数据库当前日期和服务器时区（CURRENT TIMEZONE）"
    : dialect === "postgresql" ? "按数据库会话时区和当前事务日期（CURRENT_DATE）" : "按数据库会话当前日期和会话时区";
  // Case only SQL expressions, preserving identifier spellings and quoted unit / format strings.
  const expression = (bound: string) => typedBound(bound, temporal, dialect).replace(/'(?:[^']|'')*'|[A-Z_]+/g, token => upper || token.startsWith("'") ? token : token.toLowerCase());
  const choices = [
    ["TIME_TODAY", "今天", bounds.today, bounds.tomorrow, "今天 00:00 至明天 00:00"],
    ["TIME_THIS_MONTH", "本月", bounds.month, bounds.nextMonth, "本月月初至下月月初"],
    ["TIME_LAST_MONTH", "上月", bounds.lastMonth, bounds.month, "上月月初至本月月初"],
    ["TIME_LAST_7_DAYS", "近七天", bounds.sixDaysAgo, bounds.tomorrow, "含今天的七个自然日：六天前 00:00 至明天 00:00"],
  ];
  return choices.map(([operator, label, start, end, description]) => {
    const suffix = `>= ${expression(start)} ${upper ? "AND" : "and"} ${id} < ${expression(end)}$0`;
    return { operator, label, suffix, insertText: `${id} ${suffix}`, hint: `${description}；含起点不含终点；${clockHint}，执行 SQL 时由数据库计算` };
  });
}
