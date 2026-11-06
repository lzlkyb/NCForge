import { groupLogLines, logRaw, type LogLine, type LogRecord } from "./serverLog";

export interface ServiceLogRow {
  key: string;
  line: LogLine;
  kind: "line" | "exception" | "stack" | "command" | "commandText" | "actions";
  record?: LogRecord;
}

export function isLaunchCommand(line: LogLine): boolean {
  return !line.structured && /(?:java(?:\.exe)?["']?\s|^-classpath\b)/i.test(line.text) && line.text.length > 180;
}

export function serviceLogRows(lines: LogLine[], expanded: ReadonlySet<number>, query: string): ServiceLogRow[] {
  const q = query.trim().toLowerCase(), rows: ServiceLogRow[] = [];
  for (const record of groupLogLines(lines)) {
    const { line, stack } = record;
    const command = isLaunchCommand(line);
    rows.push({ key: String(line.id), line, kind: stack.length ? "exception" : command ? "command" : "line", record });
    const open = expanded.has(line.id) || (!!q && (stack.length ? stack.some(l => logRaw(l).toLowerCase().includes(q)) : command && logRaw(line).toLowerCase().includes(q)));
    if (!open) continue;
    if (command) rows.push({ key: `command-${line.id}`, line, kind: "commandText", record });
    else if (stack.length) {
      rows.push(...stack.map(l => ({ key: String(l.id), line: l, kind: "stack" as const, record })));
      rows.push({ key: `actions-${line.id}`, line, kind: "actions", record });
    }
  }
  return rows;
}

export interface ServiceLogMatch { id: number; recordId: number; }
export function serviceLogMatches(lines: LogLine[], query: string): ServiceLogMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return groupLogLines(lines).flatMap(({ line, stack }) => [line, ...stack].filter(l => logRaw(l).toLowerCase().includes(q)).map(l => ({ id: l.id, recordId: line.id })));
}

/** 二分索引有界，4000 行不需要每次滚动扫描全部文本。 */
export function rowAtOffset(offsets: readonly number[], top: number): number {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (offsets[mid] <= top) lo = mid; else hi = mid - 1; }
  return Math.min(lo, Math.max(0, offsets.length - 2));
}
