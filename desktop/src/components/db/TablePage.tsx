import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { TableData } from "./TableData";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type ColumnInfo, type IndexInfo } from "../../lib/dbApi";
import { newConsole } from "../../lib/dbActions";
import { columnsOf, patchTab, rtOf, useDb, type TableSub, type TableTab } from "../../lib/dbStore";

const SUBS: { key: TableSub; label: string }[] = [
  { key: "data", label: "数据" },
  { key: "struct", label: "结构" },
  { key: "idx", label: "索引" },
  { key: "ddl", label: "DDL" },
];

/** 表页：数据 / 结构（含 NC 中文名）/ 索引 / DDL。 */
export function TablePage({ tab }: { tab: TableTab }) {
  useDb();
  const rt = rtOf(tab.connId);
  const lower = tab.table.toLowerCase();
  const isView = rt.tables?.find((t) => t.name === tab.table)?.kind === "VIEW";
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setCols(null);
    setErr(null);
    if (rt.status !== "connected") return;
    columnsOf(tab.connId, tab.table).then(setCols, (e) => setErr(friendlyDbError(e)));
  }, [tab.connId, tab.table, rt.status]);

  const zh = Object.fromEntries((cols ?? []).filter((c) => c.zh).map((c) => [c.name.toLowerCase(), c.zh!]));

  return (
    <div className="dbx-page">
      <div className="dbx-subtabs" role="tablist">
        <span className="title">
          <Icon name={isView ? "eye" : "database"} size={14} />
          <span className="dbx-mono">{lower}</span>
          {rt.ncNames?.[lower] && <span className="dbx-muted" style={{ fontWeight: 400 }}>{rt.ncNames[lower]}</span>}
        </span>
        {SUBS.map((s) => (
          <button key={s.key} type="button" role="tab" className="t" data-on={tab.sub === s.key || undefined} onClick={() => patchTab<TableTab>(tab.id, { sub: s.key })}>
            {s.label}
          </button>
        ))}
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn ghost" onClick={() => void newConsole(tab.connId, `select * from ${lower} where rownum <= 100`)}>
          <Icon name="terminal" size={12} />
          在控制台查询
        </button>
      </div>
      {rt.status !== "connected" && <div className="dbx-empty">连接已断开，先在左侧连上</div>}
      {err && <div className="dbx-err">{err}</div>}
      {rt.status === "connected" && tab.sub === "data" && <TableData tab={tab} cols={cols} isView={isView} zh={zh} />}
      {rt.status === "connected" && tab.sub === "struct" && <StructView cols={cols} />}
      {rt.status === "connected" && (tab.sub === "idx" || tab.sub === "ddl") && <MetaText key={tab.sub} tab={tab} />}
    </div>
  );
}

function StructView({ cols }: { cols: ColumnInfo[] | null }) {
  if (!cols) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  return (
    <div className="dbx-meta">
      <table>
        <thead>
          <tr><th>#</th><th>字段</th><th>中文名（NC）</th><th>类型</th><th>可空</th><th>默认值</th><th>注释</th></tr>
        </thead>
        <tbody>
          {cols.map((c, i) => (
            <tr key={c.name}>
              <td className="dbx-muted">{i + 1}</td>
              <td className="mono">{c.pk && <span className="pk" title="主键">PK </span>}{c.name.toLowerCase()}</td>
              <td>{c.zh ?? ""}</td>
              <td className="mono">{c.full}</td>
              <td>{c.nullable ? "是" : ""}</td>
              <td className="mono">{c.default ?? ""}</td>
              <td>{c.comment ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 索引表与 DDL：切到这页时按需读。 */
function MetaText({ tab }: { tab: TableTab }) {
  const [idx, setIdx] = useState<IndexInfo[] | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const fail = (e: unknown) => setErr(friendlyDbError(e));
    if (tab.sub === "idx") dbApi.indexes(tab.connId, tab.table).then((r) => setIdx(r.indexes), fail);
    else dbApi.ddl(tab.connId, tab.table).then((r) => setDdl(r.ddl), fail);
  }, [tab.connId, tab.table, tab.sub]);
  if (err) return <div className="dbx-err">{err}</div>;
  if (tab.sub === "ddl") {
    if (ddl === null) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
    return (
      <>
        <div className="dbx-rtool">
          <span className="meta">DBMS_METADATA.GET_DDL（已去掉存储参数）</span>
          <span className="dbx-sp" />
          <button type="button" className="dbx-btn ghost" onClick={() => void navigator.clipboard.writeText(ddl).then(() => toast("已复制 DDL", "success"))}>
            <Icon name="copy" size={12} />
            复制
          </button>
        </div>
        <pre className="dbx-ddl">{ddl}</pre>
      </>
    );
  }
  if (!idx) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  return (
    <div className="dbx-meta">
      <table>
        <thead>
          <tr><th>索引</th><th>字段</th><th>唯一</th><th>状态</th></tr>
        </thead>
        <tbody>
          {idx.map((i) => (
            <tr key={i.name}>
              <td className="mono">{i.name.toLowerCase()}</td>
              <td className="mono">{i.columns.toLowerCase()}</td>
              <td>{i.unique ? "唯一" : ""}</td>
              <td>{i.status}</td>
            </tr>
          ))}
          {idx.length === 0 && <tr><td colSpan={4} className="dbx-muted">没有索引</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
