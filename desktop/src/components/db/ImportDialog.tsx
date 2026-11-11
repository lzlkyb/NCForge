import { useEffect, useMemo, useRef, useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { friendlyDbError } from "../../lib/db";
import { autoMap, type ParsedRows } from "../../lib/csvParse";
import { planImport } from "../../lib/csvImport";
import { readImportFile } from "../../lib/importFile";
import { dbApi, dbSourceOf, type ColumnInfo, type ImportFail } from "../../lib/dbApi";
import { connOf } from "../../lib/dbStore";
import { confirmProdWrite } from "../../lib/dbConfirm";
import { beginOperation, cancelOperation, type OperationHandle } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { MapGrid } from "./ImportColumnMap";
import { ImportProgress, type ImportBusy, type ImportResult } from "./ImportProgress";

/** 一批多少行。太小则往返多，太大则一条命令里全是拼出来的 SQL。 */
const BATCH = 200;
/** 预览最多看几行；导入前扫一眼列对不对就够，不再多。 */
const PREVIEW = 5;

/**
 * CSV / TSV / JSON 导入到表。
 *
 * 三段式：选文件 → 对列（自动按列名匹配，可改，可忽略）→ 执行（分批、逐批报结果）。
 * **列映射是这里唯一的判断点**：对错了不会报错，只会把名字写进日期列。所以自动只匹配
 * 「看起来就是同一列」的，其余留给用户手点。
 */
export function ImportDialog({ connId, table, cols, onClose, onDone,tabId }: {
  connId: string;
  table: string; tabId?:string;
  /** 目标表的列；`null` 时自己读一次（表页是懒加载的，进页面时可能还没读完）。 */
  cols: ColumnInfo[] | null;
  onClose: () => void;
  /** 导入结束后刷新数据页。 */
  onDone: () => void;
}) {
  const [target, setTarget] = useState<ColumnInfo[] | null>(cols);
  /** 文件名与解析结果绑在一起：换文件时不会出现"新名字 + 旧列映射"。 */
  const [src, setSrc] = useState<{ name: string; csv: ParsedRows | null; encoding: string; reading:boolean; sheet:string }>({
    name: "",
    csv: null,
    encoding: "", reading:false, sheet: "",
  });
  const [map, setMap] = useState<number[]>([]);
  const [skip, setSkip] = useState(false);
  /** `canceling` 并进 busy：多一个 useState 就撞组件体量门禁（8 个）的上限，
   *  而它本来就是「这次导入进行到哪一步」的一部分。 */
  const [busy, setBusy] = useState<ImportBusy | null>(null);
  const [out, setOut] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 取消只置标志：正在飞的那一批必须写完，否则请求发出去了却不知道结果。 */
  const cancelRef = useRef(false);
  const taskRef=useRef<OperationHandle|null>(null);
  const readSeq=useRef(0);
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
    const seq=++readSeq.current;
    setSrc({ name: f.name, csv: null, encoding: "",reading:true, sheet:"" });
    const task=beginOperation(dbTaskSpec(`import.read:${connId}:${table}:${seq}`,"读取导入文件",connId,table,undefined,tabId));
    try {
      const { rows: r, encoding, sheet } = await readImportFile(f);
      if(seq!==readSeq.current) {task?.finish("cancelled","已选择其它文件");return;}
      if (r.headers.length === 0 || r.rows.length === 0) {
        task?.finish("failed","文件没有可导入数据");
        setErr("这个文件里没有读到数据（是不是只有表头？）");
        return;
      }
      setSrc({ name: f.name, csv: r, encoding,reading:false, sheet });
      task?.finish("success",`已读取 ${r.rows.length} 行，尚未写入数据库`);
      setMap(autoMap(r.headers, target ?? []));
    } catch (e) {
      task?.finish("failed","文件读取失败，返回导入窗口查看原因");
      if(seq===readSeq.current) setErr(`读不了这个文件：${e instanceof Error ? e.message : String(e)}`);
    } finally {if(seq===readSeq.current) setSrc(v=>({...v,reading:false}));}
  };

  const run = async () => {
    if (!parsed || !target || picked.length === 0 || taskRef.current || out) return;
    // 生产库写入必须二次确认，且带着目标表与行数；导入按批独立提交，落库后只剩人工收拾。
    const prodText = `-- 导入 ${parsed.rows.length} 行到 ${table}（${picked.length} 列）`;
    if (!(await confirmProdWrite(tabId ?? connId, connId, prodText))) return;
    const task=beginOperation({...dbTaskSpec(`import:${connId}:${table}`,"导入表数据",connId,`${table} · 独立导入会话`,undefined,tabId),cancel:async()=>{cancelRef.current=true;setBusy(v=>v ? {...v,canceling:true} : v);}});
    if(!task) return;taskRef.current=task;
    setErr(null);
    setOut(null);
    // 切批与行号换算是纯函数（lib/csvImport），这里只管发请求与报进度
    const plan = planImport(parsed, target, picked, BATCH);
    let inserted = 0;
    const failed: ImportFail[] = [];
    const t0 = Date.now();
    let stopped = false, rolledBack=false;
    cancelRef.current = false;
    setBusy({ done: 0, total: parsed.rows.length, canceling: false });
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
          canceling: cancelRef.current,
        });
        task.update({phase:"分批写入（每批独立提交）",progress:{done:Math.min(inserted+failed.length,parsed.rows.length),total:parsed.rows.length}});
        if (!res.committed) {rolledBack=true;break;} // 遇错停：这一批已回滚，后面的不再试
      }
      task.finish(stopped ? "cancelled" : failed.length || rolledBack ? "failed" : "success",`已写入 ${inserted} 行，失败 ${failed.length} 行${stopped ? "；已在批次边界停止" : rolledBack ? "；当前批已回滚" : ""}`);
      setOut({ inserted, failed, ms: Date.now() - t0, canceled: stopped });
      if (inserted > 0) onDone();
    } catch (e) {
      task.finish("failed",`导入中断；前 ${inserted} 行已写入，返回导入窗口核对`);
      // 已经写进去的批不会因为异常消失：进度摘要照给，错误另显示。
      // 少这一行的话，用户点过取消后又遇错，界面只剩一条错误，「到底写了多少」没人知道。
      setOut({ inserted, failed, ms: Date.now() - t0, canceled: cancelRef.current });
      if (inserted > 0) onDone();
      setErr(friendlyDbError(e));
    } finally {
      taskRef.current=null;setBusy(null);
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
    <Modal keepMountedWhenInactive open onClose={requestClose} closeOnOverlay={!busy} className="modal-surface dbx-dlg wide" ariaLabel={`导入数据到 ${table}`}>
      <div className="hd">
        <Icon name="upload" size={16} />
        导入数据
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          → {table.toLowerCase()}
        </span>
        {/* 导入写的是哪个库必须一直看得见：只看表名，跨账套时很容易导错地方 */}
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: "auto" }}>{dbSourceOf(connOf(connId))}</span>
      </div>
      <div className="bd one">
        <p className="dbx-hint">写入方式：新增记录 · 每批最多 {BATCH} 行，使用独立会话提交。停止后，已提交的批次仍会保留。</p>
        <div className="dbx-hint">
          读本机的 CSV / TSV / JSON / XLSX 文件：CSV 的 UTF-8 与 Excel 默认的 GBK/GB18030 自动识别（文件名旁会标出实际编码）；JSON 支持对象数组、二维数组与单对象；
          XLSX 只读<b>第一张工作表</b>（合并单元格只取值、公式只取缓存结果，超过 20 万行报错而不是截断）。空单元格写成 <b>NULL</b>（Oracle 里空串本来就是 NULL）；
          日期按 <span className="dbx-mono">YYYY-MM-DD HH24:MI:SS</span> 转——<b>XLSX 里的日期列请先在 Excel 中设成「文本」</b>，否则读到的是 45900 这样的天数序列。
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
              accept=".csv,.tsv,.txt,.json,.xlsx,.xlsm"
              disabled={!!busy}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {src.reading && <span role="status"><Icon name="spinner" size={12} />读取文件中…</span>}
          {fileName && (
            <span className="dbx-mono dbx-muted">
              {fileName}
              {src.encoding && ` · ${src.encoding}`}
              {src.sheet && ` · 工作表 ${src.sheet}`}
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
          <MapGrid
            headers={parsed.headers}
            samples={parsed.rows.slice(0, PREVIEW)}
            map={map}
            cols={target ?? []}
            onChange={(v, i) => setMap(map.map((m, k) => (k === i ? v : m)))}
            dupTarget={dupTarget}
          />
        )}
        {parsed && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            遇错跳过坏行（否则这一批整批退回）
          </label>
        )}

        <ImportProgress busy={busy} err={err} out={out} />
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
          // 点完要立刻有反馈：大表上一批可能跑几十秒，按钮不变用户会以为没点上。
          <button
            type="button"
            className="dbx-btn ghost"
            disabled={busy.canceling}
            onClick={() => {
              if(taskRef.current) void cancelOperation(taskRef.current.id);
            }}
          >
            {busy.canceling ? "取消中…" : "取消导入"}
          </button>
        ) : (
          <button type="button" className="dbx-btn ghost" onClick={requestClose}>
            {out ? "关闭" : "取消"}
          </button>
        )}
        <button type="button" className="dbx-btn" disabled={!canRun} title={out ? "这次导入已结束；要再导一遍请重新选择文件" : undefined} onClick={() => void run()}>
          <Icon name={busy ? "spinner" : "upload"} size={12} />
          {busy ? "导入中…" : "开始导入"}
        </button>
      </div>
    </Modal>
  );
}
