import { useCallback, useEffect, useState } from "react";
import { bmfPublishProbe, type BmfPublishProbe } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

const STATUS_TEXT: Record<string, string> = { ok: "通过", warn: "需确认", block: "阻断" };

/**
 * 发布 POC（M3）。
 *
 * 这一页只做三件事：检查前置条件、给出官方流程操作手册、把证据带回来。
 * 不做「一键发布」——发布改的是数据库元数据与缓存，自动化会把可回滚变成不可控。
 */
export function MetaPublish({ component, module, path }: { component: string; module: string; path: string }) {
  const [probe, setProbe] = useState<BmfPublishProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setProbe(await bmfPublishProbe(component, module, path));
    } catch (e) {
      // 失败时清掉上一次结果：留着旧的「前置条件通过」比什么都不显示更危险。
      setProbe(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [component, module, path]);

  useEffect(() => {
    void run();
  }, [run]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制`, "success");
    } catch {
      toast("复制失败：剪贴板不可用", "error");
    }
  };

  return (
    <div className="meta-publish">
      <div className="meta-publish-head">
        <div>
          <h4 className="meta-section-title">单组件发布 POC</h4>
          <p className="meta-note m-0">
            只验证「自研 BMF → 建表 → 官方发布 → 运行时能取到元数据」这条链；不自动发布、不连数据库。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
            <Icon name="refresh" size={13} /> 重新探测
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void copy(probe?.manual ?? "", "操作手册")} disabled={!probe}>
            <Icon name="copy" size={13} /> 复制手册
          </Button>
        </div>
      </div>

      {busy && <p className="meta-note">正在检查…</p>}
      {!busy && err && <p className="meta-error">探针失败：{err}</p>}

      {probe && !busy && (
        <>
          <div className={`meta-ready ${probe.ready ? "is-ready" : "is-blocked"}`}>
            <Icon name={probe.ready ? "check" : "alertTriangle"} size={16} />
            <strong>
              {probe.ready
                ? "前置条件通过，可以按手册开始"
                : `${probe.blockers} 项阻断，先解决再发布`}
            </strong>
            <span>
              {probe.warnings} 项需人工确认 · 目标环境 {probe.ncHome ?? "未识别"}
            </span>
          </div>

          <div className="meta-check-list">
            {probe.checks.map((c) => (
              <article key={c.id} className={`meta-check sev-${c.status === "block" ? "error" : c.status === "warn" ? "warn" : "ok"}`}>
                <header>
                  <span className={`meta-sev-dot sev-${c.status === "block" ? "error" : c.status === "warn" ? "warn" : "ok"}`} />
                  <strong>{c.label}</strong>
                  <span className="meta-issue-code">{STATUS_TEXT[c.status]}</span>
                </header>
                <p className="meta-mono">{c.detail}</p>
                <p className="meta-issue-why">{c.hint}</p>
              </article>
            ))}
          </div>

          <div className="meta-manual">
            <div className="meta-manual-head">
              <span>操作手册</span>
              <span className="text-[11px] text-muted-foreground">Markdown，可直接贴给同事</span>
            </div>
            <pre>{probe.manual}</pre>
          </div>
        </>
      )}
    </div>
  );
}
