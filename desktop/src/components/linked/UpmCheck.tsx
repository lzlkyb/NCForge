import { useState } from "react";
import { Icon } from "../ui/icon";
import {
  UPM_ISSUE_LABEL,
  upmEntryLabel,
  upmLookup,
  type UpmHit,
  type UpmReport,
} from "../../lib/upm";

/**
 * 「UPM 装配」卡：把 `META-INF/*.upm` 读成「接口 → 实现」的表，并给出四类诊断。
 *
 * 为什么要它：这张表是 NC 运行时 lookup 的唯一依据，编译器不校验。实现类改名、
 * 挪包、没装配，编译全绿，启动才炸（实测本机 39 条装配里有 1 条彻底悬空）。
 *
 * 两个刻意的取舍：
 * 1. **两档校验**。默认只扫 upm 与工程源码（不到 1 秒）；判定「实现类真的不存在」
 *    要动 jar 类索引，首次 10~100 秒，所以做成显式按钮。不把慢操作藏在默认路径里。
 * 2. **查不全都说出来**。`classCheckComplete=false` 时界面必须写清「缺失类没判定」，
 *    否则一片绿会被读成「装配都没问题」——那是撒谎。
 */
export function UpmCheck({
  running,
  deep,
  error,
  report,
  stale,
  elapsedMs,
  onRun,
}: {
  running: boolean;
  deep: boolean;
  error: string | null;
  report: UpmReport | null;
  /** 结果还在，但工作区已经换了 */
  stale: boolean;
  elapsedMs: number | null;
  onRun: (opts?: { deep?: boolean; refresh?: boolean }) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<UpmHit[] | null>(null);
  const [lookErr, setLookErr] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  async function search() {
    const v = q.trim();
    if (!v) return;
    setLooking(true);
    setLookErr(null);
    try {
      setHits(await upmLookup(v));
    } catch (e) {
      setLookErr(String(e));
      setHits(null);
    } finally {
      setLooking(false);
    }
  }

  const errors = report?.issues.filter((i) => i.severity === "error") ?? [];
  const warns = report?.issues.filter((i) => i.severity === "warning") ?? [];
  const shown = [...errors, ...warns].slice(0, 20);
  const rest = errors.length + warns.length - shown.length;

  return (
    <section className="lnk-sec">
      <h3 className="lnk-sec-title">
        UPM 装配
        <span className="lnk-hint">
          接口 → 实现的注册表；运行时 lookup 只认它，编译器不校验
        </span>
        <span className="lnk-sp" />
        <button
          type="button"
          className="lnk-btn"
          disabled={running}
          onClick={() => onRun()}
          title="扫 upm 与工程源码，通常不到 1 秒"
        >
          <Icon name="refresh" size={12} />
          {running && !deep ? "检查中…" : "校验装配"}
        </button>
        <button
          type="button"
          className="lnk-btn"
          disabled={running}
          onClick={() => onRun({ deep: true })}
          title="额外建/用 jar 类索引，才能判定实现类是否真的不存在。首次 10~100 秒"
        >
          {running && deep ? "深度校验中…" : "深度校验"}
        </button>
      </h3>

      {error && (
        <div className="lnk-error">
          <Icon name="alertTriangle" size={14} />
          <span>校验失败：{error}</span>
        </div>
      )}

      {stale && (
        <p className="lnk-warn">工作区已经换了：下面是上一次的结果，请重新校验。</p>
      )}

      {report && (
        <>
          <div className="lnk-sum">
            <span>
              工程 <b>{report.stats.projectFiles}</b> 个 / 产品{" "}
              <b>{report.stats.productFiles}</b> 个 upm
            </span>
            <span>
              <b>{report.stats.components}</b> 条装配 · <b>{report.stats.interfaces}</b> 个接口 ·{" "}
              <b>{report.stats.modules}</b> 个模块
            </span>
            {elapsedMs !== null && (
              <span className="lnk-hint">用了 {(elapsedMs / 1000).toFixed(1)} 秒</span>
            )}
          </div>

          {!report.classCheckComplete && (
            <p className="lnk-hint">
              本次只查了工程源码与 NCHOME 散类：<b>实现类是否真的不存在没有判定</b>
              （需要 jar 类索引，点「深度校验」）。
            </p>
          )}

          {report.issues.length === 0 && (
            <p className="lnk-ok">
              {report.classCheckComplete
                ? "装配表内部一致：没有悬空的接口/实现，也没有重复装配。"
                : "没发现结构与覆盖问题（缺失类未判定）。"}
            </p>
          )}

          {report.issues.length > 0 && (
            <>
              <div className="lnk-sum">
                <span>
                  <b>{errors.length}</b> 个错误
                </span>
                <span className="lnk-hint">{warns.length} 个提示</span>
                <span className="lnk-hint">
                  悬空装配编译能过，运行时 lookup 才炸
                </span>
              </div>
              <ul className="lnk-chk">
                {shown.map((i, n) => (
                  <li key={`${i.kind}-${i.path}-${i.className}-${n}`} className="lnk-chk-item">
                    <span className="lnk-badge" data-kind={i.severity === "error" ? "bad" : "warn"}>
                      {UPM_ISSUE_LABEL[i.kind]}
                    </span>
                    <span className="lnk-chk-msg">
                      {i.detail}
                      <br />
                      <span className="lnk-hint" title={i.path}>
                        {i.module} · {i.path}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {rest > 0 && <p className="lnk-hint">还有 {rest} 条未显示。</p>}
            </>
          )}

          {report.notes.length > 0 && (
            <p className="lnk-hint" title={report.notes.slice(0, 10).join("\n")}>
              {report.notes.length} 条解析提示（空 upm / 读不动），点开看前 10 条。
            </p>
          )}
        </>
      )}

      <div className="lnk-upm-q">
        <input
          className="lnk-input"
          value={q}
          placeholder="查装配：接口全名或实现类名，回车"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        <button
          type="button"
          className="lnk-btn"
          disabled={looking || q.trim() === ""}
          onClick={() => void search()}
        >
          {looking ? "查中…" : "查装配"}
        </button>
      </div>

      {lookErr && (
        <div className="lnk-error">
          <Icon name="alertTriangle" size={14} />
          <span>查询失败：{lookErr}</span>
        </div>
      )}

      {hits && hits.length === 0 && (
        <p className="lnk-warn">
          没有任何 upm 装配这个类：<b>NCLocator.lookup 会直接失败</b>
          （除非它是 Spring bean 或根本不需要装配）。
        </p>
      )}

      {hits && hits.length > 0 && (
        <ul className="lnk-chk">
          {hits.map((h, n) => (
            <li key={`${h.path}-${h.interface}-${n}`} className="lnk-chk-item">
              <span className="lnk-badge" data-kind={h.origin === "project" ? "primary" : "muted"}>
                {h.origin === "project" ? "工程" : "产品"}
              </span>
              <span className="lnk-chk-msg">
                <span title={h.interface}>{h.interface}</span>
                {" → "}
                <b title={h.implementation}>{h.implementation}</b>
                <br />
                <span className="lnk-hint">
                  {h.matchedBy === "interface" ? "实现" : "被装配于"} · {h.module} ·{" "}
                  {upmEntryLabel(h)} · {h.path}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
