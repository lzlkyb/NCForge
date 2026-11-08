import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import {
  entryTitle,
  severityMeta,
  type LogEntry,
  type TraceResult,
} from "../../lib/ncLog";
import { copyWithToast, openSqlInDb, runJump } from "../../lib/logActions";

/** 跳转按钮的文案 —— 让人知道点下去是去哪，而不是一个笼统的「跳转」。 */
function jumpLabel(entry: LogEntry): string | null {
  const jump = entry.verdict?.jump;
  if (!jump) return null;
  switch (jump.kind) {
    case "table":
      return `在数据库里查 ${jump.table}`;
    case "upm":
      return "打开这个 .upm";
    case "source":
      return `查类名 ${jump.class}`;
  }
}

/**
 * 详情面板：结论（为什么 / 下一步）+ 原始消息与堆栈 + 同 callid 时间线。
 *
 * 「复制到 SQL 窗口」**只在 warningsql 记录上出现**（`costMs != null`）。别的记录里
 * 的 msg 是「报错 + 半条 SQL」，直接塞进控制台跑会得到第二个错误，反而更难排查。
 */
export function LogDetail({
  entry,
  entryOutsideList = false,
  trace,
  tracing,
  onTrace,
  onSelectTrace,
  onClearTrace,
}: {
  entry: LogEntry | null;
  entryOutsideList?: boolean;
  trace: TraceResult | null;
  tracing: boolean;
  onTrace: (callId: string) => void;
  onSelectTrace: (entry: LogEntry) => void;
  onClearTrace: () => void;
}) {
  if (!entry) {
    return (
      <div className="lg-detail lg-detail-empty">
        <p>选一条记录看详情</p>
        <p className="lg-empty-hint">
          每条结论都会说明「为什么」和「下一步」；有 callid 的可在高级操作中追踪请求链路。
        </p>
      </div>
    );
  }

  const verdict = entry.verdict;
  const meta = verdict ? severityMeta(verdict.severity) : null;
  const jump = jumpLabel(entry);
  const isSql = entry.costMs !== null;
  const currentTrace = trace?.callId === entry.callId ? trace : null;

  return (
    <div className="lg-detail">
      <div className="lg-detail-head">
        <span className="lg-detail-icon" data-sev={verdict?.severity}>
          {meta ? <Icon name={meta.icon} size={14} /> : <Icon name="info" size={14} />}
        </span>
        <strong>{entryTitle(entry)}</strong>
        <span className="lg-sp" />
        {entry.callId && <Menu portal trigger={(open, toggle) => <button type="button" className="lg-btn"
          aria-haspopup="menu" aria-expanded={open} disabled={tracing} onClick={toggle}>
          {tracing ? "正在追踪…" : "高级操作"}<Icon name="chevronDown" size={12} />
        </button>}>
          {(close) => <MenuItem label="追踪这次请求" icon="activity" disabled={tracing}
            onClick={() => { close(); onTrace(entry.callId!); }} />}
        </Menu>}
        {jump && (
          <button type="button" className="lg-btn" onClick={() => void runJump(verdict!.jump!)}>
            <Icon name="external" size={13} />
            {jump}
          </button>
        )}
        {isSql && (
          <button
            type="button"
            className="lg-btn"
            onClick={() => void openSqlInDb(entry.msg)}
            title="把这条 SQL 送进数据库页的新控制台"
          >
            <Icon name="database" size={13} />
            复制到 SQL 窗口
          </button>
        )}
        <button
          type="button"
          className="lg-btn"
          onClick={() => void copyWithToast(entry.msg, "消息")}
          title="复制这条记录的消息"
          aria-label="复制这条记录的消息"
        >
          <Icon name="copy" size={13} />
        </button>
      </div>

      {entryOutsideList && (
        <p className="lg-empty-hint" role="status">此记录不在当前列表中；详情已保留。</p>
      )}

      {verdict && (
        <div className="lg-why" data-sev={verdict.severity}>
          <p>
            <b>为什么</b>
            {verdict.cause}
          </p>
          <p>
            <b>下一步</b>
            {verdict.action}
          </p>
        </div>
      )}

      <details className="lg-record-metadata"><summary>记录详情 · {entry.ts || entry.logger}</summary><div className="lg-meta">
        <Meta label="时间" value={entry.ts} />
        <Meta label="来源" value={`${entry.logger} · ${entry.file}:${entry.lineNo}`} />
        <Meta label="线程" value={entry.thread} />
        <Meta label="用户" value={entry.userId} />
        <Meta label="callid" value={entry.callId} />
        <Meta label="调用" value={entry.remoteCall} />
        {entry.costMs !== null && (
          <Meta
            label="耗时"
            value={`${entry.costMs}ms${entry.rowCount !== null ? ` · ${entry.rowCount} 行` : ""}`}
          />
        )}
      </div></details>

      <pre className="lg-msg">{entry.msg || "(无消息)"}</pre>

      {entry.stack.length > 0 && (
        <details className="lg-stack-box" open={entry.stack.length <= 8}>
          <summary>
            堆栈 / 续行 {entry.stack.length} 行{entry.stackTruncated ? "（已截断）" : ""}
          </summary>
          <pre className="lg-stack">{entry.stack.join("\n")}</pre>
        </details>
      )}

      {currentTrace && (
        <div className="lg-trace">
          <div className="lg-trace-head">
            <Icon name="activity" size={13} />
            <strong>同一次请求</strong>
            <span className="lg-sub">
              callid {currentTrace.callId} · {currentTrace.entries.length} 条 · {currentTrace.elapsedMs}ms
            </span>
            <span className="lg-sp" />
            <button type="button" className="lg-btn" aria-label="清除请求追踪" onClick={onClearTrace}>
              <Icon name="close" size={12} />
            </button>
          </div>
          {currentTrace.entries.length === 0 ? (
            <p className="lg-empty-hint">
              只扫到 {currentTrace.scannedFiles.length} 个文件里有这个 callid，但没解析出记录 ——
              可能日志已轮转掉了。
            </p>
          ) : (
            <ol className="lg-timeline">
              {currentTrace.entries.map((t, i) => (
                <li key={`${t.file}:${t.lineNo}:${i}`}>
                  <button
                    type="button"
                    className="lg-timeline-row"
                    data-sev={t.verdict?.severity}
                    onClick={() => onSelectTrace(t)}
                  >
                    <span className="lg-timeline-ts">{(t.ts ?? "—").slice(11)}</span>
                    <span className="lg-timeline-logger">{t.logger}</span>
                    <span className="lg-timeline-msg">{entryTitle(t)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <span className="lg-meta-item">
      <span className="lg-meta-label">{label}</span>
      <span className="lg-meta-value" title={value}>
        {value}
      </span>
    </span>
  );
}
