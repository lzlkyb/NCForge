import { useEffect, useMemo, useRef, useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { friendlyDbError } from "../../lib/db";
import { autoMap, decodeCsvBytes, parseCsv, type ParsedCsv } from "../../lib/csvParse";
import { planImport } from "../../lib/csvImport";
import { dbApi, type ColumnInfo, type ImportFail } from "../../lib/dbApi";

/** 一批多少行。太小则往返多，太大则一条命令里全是拼出来的 SQL。 */
const BATCH = 200;
/** 预览最多看几行；导入前扫一眼列对不对就够，不再多。 */
const PREVIEW = 5;

/**
 * CSV / TSV 导入到表。
 *
 * 三段式：选文件 → 对列（自动按列名匹配，可改，可忽略）→ 执行（分批、逐批报结果）。
 * **列映射是这里唯一的判断点**：对错了不会报错，只会把名字写进日期列。所以自动只匹配
 * 「看起来就是同一列」的，其余留给用户手点。
 */
export function ImportDialog({ connId, table, cols, onClose, onDone }: {
  connId: string;
  table: string;
  /** 目标表的列；`null` 时自己读一次（表页是懒加载的，进页面时可能还没读完）。 */
  cols: ColumnInfo[] | null;
  onClose: () => void;
  /** 导入结束后刷新数据页。 */
  onDone: () => void;
}) {
  const [target, setTarget] = useState<ColumnInfo[] | null>(cols);
  /** 文件名与解析结果绑在一起：换文件时不会出现"新名字 + 旧列映射"。 */
  const [src, setSrc] = useState<{ name: string; csv: ParsedCsv | null; encoding: string }>({
    name: "",
    csv: null,
    encoding: "",
  });
  const [map, setMap] = useState<number[]>([]);
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [out, setOut] = useState<{ inserted: number; failed: ImportFail[]; ms: number; canceled: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 取消只置标志：正在飞的那一批必须写完，否则请求发出去了却不知道结果。 */
  const cancelRef = useRef(false);
  const parsed = src.csv;
  const fileName = src.name;

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
  }, [connId, table, target]);

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

  const readFile = async (f: File) => {
    setErr(null);
    setOut(null);
    setSrc({ name: f.name, csv: null, encoding: "" });
    try {
      const { text, encoding } = await decodeCsvBytes(f);
      const r = parseCsv(text);
      if (r.headers.length === 0 || r.rows.length === 0) {
        setErr("这个文件里没有读到数据（是不是只有表头？）");
        return;
      }
      setSrc({ name: f.name, csv: r, encoding });
      setMap(autoMap(r.headers, target ?? []));
    } catch (e) {
      setErr(`读不了这个文件：${String(e)}`);
    }
  };

  const run = async () => {
    if (!parsed || !target || picked.length === 0) return;
    setErr(null);
    setOut(null);
    // 切批与行号换算是纯函数（lib/csvImport），这里只管发请求与报进度
    const plan = planImport(parsed, target, picked, BATCH);
    let inserted = 0;
    const failed: ImportFail[] = [];
    const t0 = Date.now();
    let stopped = false;
    cancelRef.current = false;
    setBusy({ done: 0, total: parsed.rows.length });
    try {
      for (const ch of plan.chunks) {
        if (cancelRef.current) {
          stopped = true;
          break;
        }
        const res = await dbApi.importRows({
          id: connId,
          table,
          columns: plan.columns,
          rows: ch.rows,
          startLine: ch.startLine,
          skipErrors: skip,
        });
        inserted += res.inserted;
        failed.push(...res.failed);
        setBusy({
          done: Math.min(inserted + failed.length, parsed.rows.length),
          total: parsed.rows.length,
        });
        if (!res.committed) break; // 遇错停：这一批已回滚，后面的不再试
      }
      setOut({ inserted, failed, ms: Date.now() - t0, canceled: stopped });
      if (inserted > 0) onDone();
    } catch (e) {
      setErr(friendlyDbError(e));
    } finally {
      setBusy(null);
    }
  };

  // 导入结束（out 有值）后不允许再点：同一份文件再导一遍就是整批重复数据，
  // 而表上往往没有唯一约束兜底。要再导必须先重新选文件（readFile 会清掉 out）。
  const canRun = !!parsed && !!target && picked.length > 0 && !dupTarget && !busy && !out;
  // 导入中途关窗会让分批循环失去界面：已写入的批次无法撤回，失败也没人看见。
  // 关不掉比「悄悄写了一半」诚实——按钮、Esc、遮罩三条路统一由 busy 拦下。
  const requestClose = () => {
    if (!busy) onClose();
  };

  return (
    <Modal open onClose={requestClose} closeOnOverlay={!busy} className="modal-surface dbx-dlg wide" ariaLabel={`导入数据到 ${table}`}>
      <div className="hd">
        <Icon name="upload" size={16} />
        导入数据
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          → {table.toLowerCase()}
        </span>
      </div>
      <div className="bd one">
        <div className="dbx-hint">
          读本机的 CSV / TSV 文本，UTF-8 与 Excel 默认的 GBK/GB18030 都能自动识别（文件名旁会标出实际编码）。空单元格写成 <b>NULL</b>（Oracle 里空串本来就是 NULL）；
          日期按 <span className="dbx-mono">YYYY-MM-DD HH24:MI:SS</span> 转。每批 {BATCH} 行自成事务，走独立会话——
          不会把你在这个连接上未提交的改动一起提交。
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          {/* label 包 input：点它等于点 input，省掉 useRef（组件体量门禁按 hook 数算账） */}
          <label
            className="dbx-btn"
            style={busy ? { opacity: 0.5, pointerEvents: "none" } : undefined}
            aria-disabled={!!busy}
          >
            <Icon name="upload" size={12} />
            选择文件
            <input
              type="file"
              accept=".csv,.tsv,.txt"
              disabled={!!busy}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {fileName && (
            <span className="dbx-mono dbx-muted">
              {fileName}
              {src.encoding && ` · ${src.encoding}`}
            </span>
          )}
          {parsed && (
            <span className="dbx-muted">
              {parsed.headers.length} 列 · {parsed.rows.length} 行
              {parsed.blankLines > 0 && `（跳过 ${parsed.blankLines} 个空行）`}
            </span>
          )}
        </div>

        {parsed && (
          <>
            <div className="dbx-maphd">列映射</div>
            <div className="dbx-mapgrid">
              <div className="h">文件列</div>
              <div className="h">样例（前 {PREVIEW} 行）</div>
              <div className="h">写入表的列</div>
              {parsed.headers.map((h, i) => (
                <MapRow
                  key={`${h}:${i}`}
                  head={h || `第 ${i + 1} 列`}
                  samples={parsed.rows.slice(0, PREVIEW).map((r) => r[i] ?? "")}
                  value={map[i] ?? -1}
                  cols={target ?? []}
                  onChange={(v) => setMap(map.map((m, k) => (k === i ? v : m)))}
                />
              ))}
            </div>
            {dupTarget && <div className="dbx-err" style={{ marginTop: 6 }}>同一目标列被映射了两次，改一下再导</div>}
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              遇错跳过坏行（否则这一批整批退回）
            </label>
          </>
        )}

        {busy && (
          <div className="dbx-hint" style={{ marginTop: 8 }}>
            正在写：{busy.done} / {busy.total} 行…（点「取消导入」会在当前批写完后停下）
          </div>
        )}
        {err && <div className="dbx-err" style={{ marginTop: 8 }}>{err}</div>}
        {out && (
          <div className="dbx-hint" style={{ marginTop: 8 }}>
            <div style={{ color: "hsl(var(--foreground))" }}>
              {out.canceled ? "已取消 · 已写进 " : "写进 "}
              <b>{out.inserted}</b> 行 · {(out.ms / 1000).toFixed(1)}s
              {out.failed.length > 0 && (
                <b style={{ color: "hsl(var(--destructive-ink))" }}> · 失败 {out.failed.length} 行</b>
              )}
            </div>
            {out.failed.length > 0 && (
              <div className="dbx-mono" style={{ maxHeight: 120, overflow: "auto", marginTop: 4 }}>
                {out.failed.slice(0, 20).map((f) => (
                  <div key={`${f.line}:${f.error}`}>第 {f.line} 行：{f.error}</div>
                ))}
                {out.failed.length > 20 && <div>……还有 {out.failed.length - 20} 条</div>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ft">
        <span className="dbx-muted">
          {parsed ? `将写入 ${picked.length} 列` : "先选一个文件"}
          {!target && " · 读取表结构…"}
        </span>
        <span className="dbx-sp" />
        {busy ? (
          // 写入中不能关窗（已写的批次撤不回），但必须留一条停下来的路：
          // 只置标志、当前批写完再停，进度与结果仍然可见。
          <button type="button" className="dbx-btn ghost" onClick={() => { cancelRef.current = true; }}>
            取消导入
          </button>
        ) : (
          <button type="button" className="dbx-btn ghost" onClick={requestClose}>
            {out ? "关闭" : "取消"}
          </button>
        )}
        <button type="button" className="dbx-btn" disabled={!canRun} title={out ? "这次导入已结束；要再导一遍请重新选择文件" : undefined} onClick={() => void run()}>
          <Icon name="upload" size={12} />
          开始导入
        </button>
      </div>
    </Modal>
  );
}

/** 一行映射：文件列名 + 样例值 + 目标列下拉。 */
function MapRow({ head, samples, value, cols, onChange }: {
  head: string;
  samples: string[];
  value: number;
  cols: ColumnInfo[];
  onChange: (v: number) => void;
}) {
  return (
    <>
      <div className="dbx-mono">{head}</div>
      <div className="dbx-mapcell">
        {samples.map((s, i) => (
          <span key={i} className="dbx-mono">{s === "" ? <span className="dbx-muted">（空）</span> : s}</span>
        ))}
      </div>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={-1}>（不导入这一列）</option>
        {cols.map((c, i) => (
          <option key={c.name} value={i}>
            {c.name.toLowerCase()} · {c.full}
          </option>
        ))}
      </select>
    </>
  );
}
