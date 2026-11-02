import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { failureText } from "../../lib/friendlyError";
import { getConfig, patchConfig } from "../../lib/appConfig";
import {
  deployApply,
  deployCleanup,
  deployPreview,
  deployStatus,
  type CleanupReport,
  type DeployReport,
} from "../../lib/deploy";

type Busy = "preview" | "apply" | "cleanup" | null;

/** 把后端报告拆成几行给人看的话（详情面板里逐条列文件）。 */
function summarize(r: DeployReport): string[] {
  const out: string[] = [];
  if (r.comboChanged) {
    out.push(
      r.previousCombo.length === 0
        ? "这是该 NC home 的首次投送"
        : `部署组合已变化：${r.previousCombo.join(" + ")} → ${r.projectRoots.join(" + ")}`,
    );
  }
  out.push(
    `${r.applied ? "已投送" : "将投送"} ${r.planned} 个文件：新增 ${r.created.length}、更新 ${r.updated.length}、接管 ${r.adopted.length}、未变 ${r.unchanged}`,
  );
  if (r.conflicts.length > 0) {
    out.push(`${r.conflicts.length} 个文件被多个工程声明且内容不同，已按类路径顺序取第一个`);
  }
  if (r.skipped.length > 0) out.push(`${r.skipped.length} 项被跳过（见下方明细）`);
  return out;
}

/**
 * 元数据投送卡片：把工程 `META-INF` 的 upm/rest 同步到 NCHOME。
 *
 * NC 按文件路径读组件注册表，改了 upm 不落地，运行时读到的还是 NCHOME 里的旧版本。
 * 「编译/启动前自动投送」默认开；卡片提供手动预览、立即投送与清理（还原备份）。
 */
export function MetaDeployCard() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [report, setReport] = useState<DeployReport | null>(null);
  const [cleaned, setCleaned] = useState<CleanupReport | null>(null);

  const status = useQuery({
    queryKey: ["deploy-status"],
    queryFn: deployStatus,
    retry: false,
    staleTime: 10_000,
  });
  const cfg = useQuery({ queryKey: ["app-config"], queryFn: getConfig, retry: false });

  const run = async (kind: Exclude<Busy, null>) => {
    setBusy(kind);
    try {
      if (kind === "cleanup") {
        const c = await deployCleanup();
        setCleaned(c);
        setReport(null);
        toast(`已删除 ${c.deleted.length} 个、还原 ${c.restored.length} 个文件`, "success");
      } else {
        const r = kind === "apply" ? await deployApply() : await deployPreview();
        setReport(r);
        setCleaned(null);
        if (kind === "apply") {
          toast(`已投送 ${r.created.length + r.updated.length} 个文件到 NCHOME`, "success");
        }
      }
      void status.refetch();
    } catch (e) {
      toast(failureText(kind === "cleanup" ? "清理元数据" : "投送元数据", e), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async (next: boolean) => {
    const old = cfg.data;
    if (old) queryClient.setQueryData(["app-config"], { ...old, deploy_on_start: next });
    try {
      await patchConfig({ deploy_on_start: next });
    } catch (e) {
      if (old) queryClient.setQueryData(["app-config"], old);
      toast(failureText("保存自动投送设置", e), "error");
    }
  };

  const st = status.data;
  const auto = cfg.data?.deploy_on_start ?? true;

  return (
    <section className="sv-deploy" data-open={open}>
      <div className="sv-deploy-head">
        <button
          type="button"
          className="sv-link"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          元数据投送
        </button>
        <span className="sv-deploy-sub">
          {st?.hasManifest
            ? `已投送 ${st.files} 个文件（${st.written} 个由本工具写入${st.backups ? `，${st.backups} 个有备份` : ""}）`
            : "尚未投送过：工程里的 META-INF 改动不会自动生效"}
        </span>
        <span className="sv-sp" />
        <label className="sv-deploy-auto" title="编译成功、启动服务前自动执行">
          <input
            type="checkbox"
            checked={auto}
            disabled={cfg.isLoading}
            onChange={(e) => void toggleAuto(e.target.checked)}
          />
          自动投送
        </label>
        <button
          type="button"
          className="sv-btn"
          disabled={busy !== null}
          onClick={() => void run("preview")}
        >
          {busy === "preview" ? "检查中…" : "预览"}
        </button>
        <button
          type="button"
          className="sv-btn sv-btn-primary"
          disabled={busy !== null}
          onClick={() => void run("apply")}
        >
          {busy === "apply" ? "投送中…" : "立即投送"}
        </button>
        <button
          type="button"
          className="sv-btn"
          disabled={busy !== null || !st?.hasManifest}
          title="只删本工具写过的文件；被外部改过的会保留，覆盖前的备份会还原"
          onClick={() => void run("cleanup")}
        >
          {busy === "cleanup" ? "清理中…" : "清理"}
        </button>
      </div>

      {open && (
        <div className="sv-deploy-body">
          {status.isError && (
            <div className="sv-alert" data-tone="warn">
              <Icon name="info" size={14} />
              <span className="sv-alert-text">读取投送状态失败：{String(status.error)}</span>
            </div>
          )}

          {st && (
            <p className="sv-deploy-line">
              NC home：<code>{st.home}</code>
              <br />
              登记表：<code>{st.manifestPath}</code>
              {st.combo.length > 0 && (
                <>
                  <br />
                  当前组合：{st.combo.join(" + ")}
                </>
              )}
            </p>
          )}

          {report && (
            <>
              {summarize(report).map((line) => (
                <p className="sv-deploy-line" key={line}>
                  {line}
                </p>
              ))}
              {(report.created.length > 0 || report.updated.length > 0) && report.applied && (
                <ul className="sv-deploy-list">
                  {report.created.map((a) => (
                    <li key={a.target}>
                      新增 <code>{a.module}/META-INF/{a.file}</code>
                    </li>
                  ))}
                  {report.updated.map((a) => (
                    <li key={a.target}>
                      更新 <code>{a.module}/META-INF/{a.file}</code>
                      {a.backup ? "（原文件已备份）" : "（原文件不存在）"}
                    </li>
                  ))}
                </ul>
              )}
              {report.conflicts.length > 0 && (
                <ul className="sv-deploy-list">
                  {report.conflicts.map((c) => (
                    <li key={c.target}>
                      冲突 <code>{c.target}</code>：用 {c.winner}，忽略 {c.loser}
                    </li>
                  ))}
                </ul>
              )}
              {report.skipped.length > 0 && (
                <ul className="sv-deploy-list">
                  {report.skipped.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {cleaned && (
            <p className="sv-deploy-line">
              已删除 {cleaned.deleted.length} 个、还原 {cleaned.restored.length} 个文件
              {cleaned.skipped.length > 0 ? `；${cleaned.skipped.length} 项跳过` : ""}
            </p>
          )}

          <p className="sv-deploy-hint">
            只写 <code>modules/&lt;模块&gt;/META-INF/</code> 下的文件；覆盖前先备份，
            清理时只删本工具写过且内容未被外部改动的文件。
          </p>
        </div>
      )}
    </section>
  );
}
