import { useEffect, useMemo, useRef, useState } from "react";
import { autoMap, type ParsedRows } from "../lib/csvParse";
import { readImportFile } from "../lib/importFile";
import { dbApi, type ColumnInfo } from "../lib/dbApi";
import { friendlyDbError } from "../lib/db";
import { beginOperation } from "../lib/operations";
import { dbTaskSpec } from "../lib/dbOperations";
import { guessDateFormat, isDateColumn, type DateGuess } from "../lib/importDate";

/** 推断格式时最多看多少行：够判形状，又不至于每次映射都扫全表。 */
const SAMPLE_ROWS = 200;

/** 一个日期目标列的判定结果。 */
export interface DateColumnInfo {
  guess: DateGuess;
  /** 已生效的格式键：用户选的优先，其次唯一推断。 */
  id?: string;
  /** 两个候选都成立且用户还没选 —— 这时不许导。 */
  needsChoice: boolean;
}

/** 文件名与解析结果绑在一起：换文件时不会出现「新名字 + 旧列映射」。 */
export interface ImportSource {
  name: string;
  csv: ParsedRows | null;
  encoding: string;
  reading: boolean;
  sheet: string;
}

const EMPTY: ImportSource = { name: "", csv: null, encoding: "", reading: false, sheet: "" };

/**
 * 导入的「读文件 + 列映射」段。
 *
 * **列映射是整套导入里唯一的判断点**：对错了不会报错，只会把名字写进日期列。
 * 所以自动匹配（`csvParse::autoMap`）只认「看起来就是同一列」的，其余留给用户手点。
 *
 * 读文件带序号（`readSeq`）：用户连点两次「选择文件」时，先发的那次可能后回来，
 * 没序号就会把旧文件的行配上新文件的列。
 */
export function useImportSource(opts: {
  connId: string;
  table: string;
  tabId?: string;
  /** 目标表的列；`null` 时自己读一次（表页是懒加载的，进页面时可能还没读完）。 */
  cols: ColumnInfo[] | null;
  setErr: (v: string | null) => void;
}) {
  const { connId, table, tabId, cols, setErr } = opts;
  const [target, setTarget] = useState<ColumnInfo[] | null>(cols);
  const [src, setSrc] = useState<ImportSource>(EMPTY);
  const [map, setMap] = useState<number[]>([]);
  const [skip, setSkip] = useState(false);
  /**
   * 目标列下标 → 用户**显式**选的日期格式键。
   *
   * 推断只作为默认值（在 `dateInfo` 里算），不写回这里：写回来就分不清「用户选的」
   * 和「猜的」，歧义判定也就失效了。也刻意不按表列持久化——同名列下次的导出格式
   * 可能来自另一个系统，记住上次的选择等于把静默错误自动化。
   */
  const [fmt, setFmt] = useState<Record<number, string>>({});
  const readSeq = useRef(0);
  const parsed = src.csv;

  useEffect(() => {
    if (target) return;
    let alive = true;
    dbApi.columns(connId, table).then(
      (r) => alive && setTarget(r.columns),
      (e) => alive && setErr(friendlyDbError(e)),
    );
    return () => {
      alive = false;
    };
  }, [connId, table, target, setErr]);

  const picked = useMemo(() => map.map((to, from) => ({ to, from })).filter((p) => p.to >= 0), [map]);

  /** 同一目标列被映射两次 = 必然错的 SQL，执行前就挡住 */
  const dupTarget = useMemo(() => {
    const seen = new Set<number>();
    for (const p of picked) {
      if (seen.has(p.to)) return true;
      seen.add(p.to);
    }
    return false;
  }, [picked]);

  /** 日期目标列的格式推断（只对 DATE / TIMESTAMP 目标列算）。 */
  const dateInfo = useMemo(() => {
    const out: Record<number, DateColumnInfo> = {};
    if (!parsed || !target) return out;
    for (const p of picked) {
      const col = target[p.to];
      if (!col || !isDateColumn(col.type)) continue;
      const samples = parsed.rows.slice(0, SAMPLE_ROWS).map((r) => r[p.from] ?? "");
      const guess = guessDateFormat(samples);
      const chosen = fmt[p.to];
      const auto = guess.kind === "ok" ? guess.id : undefined;
      out[p.to] = { guess, id: chosen ?? auto, needsChoice: guess.kind === "ambiguous" && !chosen };
    }
    return out;
  }, [parsed, target, picked, fmt]);

  const readFile = async (f: File) => {
    setErr(null);
    const seq = ++readSeq.current;
    setSrc({ name: f.name, csv: null, encoding: "", reading: true, sheet: "" });
    const task = beginOperation(
      dbTaskSpec(`import.read:${connId}:${table}:${seq}`, "读取导入文件", connId, table, undefined, tabId),
    );
    try {
      const { rows: r, encoding, sheet } = await readImportFile(f);
      if (seq !== readSeq.current) {
        task?.finish("cancelled", "已选择其它文件");
        return;
      }
      if (r.headers.length === 0 || r.rows.length === 0) {
        task?.finish("failed", "文件没有可导入数据");
        setErr("这个文件里没有读到数据（是不是只有表头？）");
        return;
      }
      setSrc({ name: f.name, csv: r, encoding, reading: false, sheet });
      task?.finish("success", `已读取 ${r.rows.length} 行，尚未写入数据库`);
      setMap(autoMap(r.headers, target ?? []));
    } catch (e) {
      task?.finish("failed", "文件读取失败，返回导入窗口查看原因");
      if (seq === readSeq.current) setErr(`读不了这个文件：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (seq === readSeq.current) setSrc((v) => ({ ...v, reading: false }));
    }
  };

  return { target, src, map, setMap, skip, setSkip, parsed, picked, dupTarget, readFile, fmt, setFmt, dateInfo };
}
