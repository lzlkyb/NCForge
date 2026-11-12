import { useEffect, useRef, useState } from "react";
import { dbApi, ENV_LABEL, type DbConn } from "../../lib/dbApi";
import { dropDdl } from "../../lib/ddlCache";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export interface DdlStepResult {
  sql: string;
  ok: boolean;
  detail: string;
}

/**
 * 把生成脚本切成单条语句。
 *
 * 只认「分号结束」的普通 DDL（生成器输出的就是这种）；字符串与 `--` 注释里的分号不切。
 * PL/SQL 块内部的分号会被误切——所以界面只对 `CREATE TABLE` 一类语句开放，块级脚本
 * 请去数据库页执行。这里不做「猜块边界」的智能解析：切错一条 DDL 比不执行更糟。
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let buf = "";
  let comment = false;
  let quote: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1];
    if (comment) {
      if (ch === "\n") {
        comment = false;
        buf += ch;
      }
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "-" && next === "-") {
      comment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ";") {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** 生成脚本里出现这些关键字就不提供执行入口：分号切分会把它们切碎。 */
function hasBlockSyntax(stmts: string[]): boolean {
  return stmts.some((s) => /^(declare|begin)\b/i.test(s) || /\b(begin|exception)\b/i.test(s));
}

/**
 * DDL 受控执行（M5）。
 *
 * 四道闸：必须选连接 → 生产连接直接拒绝 → 勾选「我确认这是测试库」→ 手打组件名。
 * 执行按语句顺序来，第一条失败就停，并把已经执行成功的语句列出来——Oracle 的 DDL
 * 自动提交，失败后库里会留下前面建好的表，这一点必须明说，不能假装能回滚。
 */
export function MetaDdlRun({ ddl, component, onRunning }: { ddl: string; component: string; onRunning?: (running: boolean) => void }) {
  const [conns, setConns] = useState<DbConn[]>([]);
  const [connId, setConnId] = useState("");
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<DdlStepResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    dbApi
      .list()
      .then((list) => {
        if (alive) setConns(list);
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      });
    return () => {
      alive = false;
      mounted.current = false;
    };
  }, []);

  const stmts = splitStatements(ddl);
  const conn = conns.find((c) => c.id === connId) ?? null;
  const isProd = conn?.env === "prod";
  const blockSyntax = hasBlockSyntax(stmts);
  const ready = !!conn && !isProd && !blockSyntax && ack && typed.trim() === component && !busy && stmts.length > 0;

  const run = async () => {
    if (!ready || !conn || running.current) return;
    running.current = true;
    onRunning?.(true);
    setBusy(true);
    setErr(null);
    setLogs([]);
    const done: DdlStepResult[] = [];
    try {
      for (const stmt of stmts) {
        // 被工作区切换等操作卸载后不再推进下一条；已经提交的 DDL 不能回滚。
        if (!mounted.current) return;
        try {
          const r = await dbApi.exec(conn.id, stmt, 50, 120);
          // 刚改完结构：这条连接上缓存的 DDL 全部作废，否则再打开还是旧定义
          dropDdl(conn.id);
          if (!mounted.current) return;
          const detail = r.kind === "update" ? `${r.ms} ms · 影响 ${r.updateCount}` : `${r.ms} ms · ${r.rowCount} 行`;
          done.push({ sql: stmt, ok: true, detail });
        } catch (e) {
          if (!mounted.current) return;
          done.push({ sql: stmt, ok: false, detail: String(e) });
          setLogs([...done]);
          return;
        }
        setLogs([...done]);
      }
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        onRunning?.(false);
      }
    }
  };

  return (
    <div className="meta-ddl">
      <div className="meta-ddl-row">
        <span className="meta-export-label">
          <Icon name="database" size={12} /> 在测试库执行
        </span>
        <select
          className="meta-ddl-conn"
          aria-label="选择执行连接"
          value={connId}
          onChange={(e) => setConnId(e.target.value)}
          disabled={busy}
        >
          <option value="">选择连接…</option>
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{ENV_LABEL[c.env]}）
            </option>
          ))}
        </select>
        <span className="meta-export-label">共 {stmts.length} 条语句</span>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={!ready}>
          {busy ? "执行中…" : "执行 DDL"}
        </Button>
      </div>

      {isProd && <p className="meta-inline-error">生产连接不允许执行 DDL；请切换到开发/测试库。</p>}
      {blockSyntax && (
        <p className="meta-inline-error">
          脚本含 PL/SQL 块，分号切分会把它切碎，这里不提供执行入口；请到数据库页手工执行。
        </p>
      )}

      <label className="meta-ddl-ack">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy} />
        我确认这是测试库；DDL 自动提交，失败时已执行的语句不会回滚
      </label>
      <input
        className="meta-export-input"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={`输入组件名 ${component} 以确认`}
        aria-label="输入组件名确认 DDL 执行"
        spellCheck={false}
        disabled={busy}
      />

      {err && <p className="meta-error">{err}</p>}

      {logs && logs.length > 0 && (
        <div className="meta-export-result">
          <ul>
            {logs.map((l, i) => (
              <li key={i} className={l.ok ? "is-written" : "is-failed"}>
                <span>{l.ok ? "成功" : "失败"}</span>
                <code>{l.sql.replace(/\s+/g, " ").slice(0, 120)}</code>
                <em>{l.detail}</em>
              </li>
            ))}
          </ul>
          {logs.every((l) => l.ok) && logs.length === stmts.length && (
            <p className="meta-note">全部语句执行成功。表已提交，回滚需要手工 DROP。</p>
          )}
        </div>
      )}
    </div>
  );
}
