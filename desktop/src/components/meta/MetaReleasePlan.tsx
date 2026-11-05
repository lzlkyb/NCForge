import { useCallback, useEffect, useState } from "react";
import {
  bmfReleaseEvidence,
  bmfReleasePlan,
  type BmfReleaseEvidenceSaved,
  type BmfReleasePlan,
} from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

const TOOL_STATUS: Record<string, string> = { found: "在位", missing: "缺失", unknown: "待确认" };
const STEP_STATUS: Record<string, string> = { ready: "就绪", blocked: "阻断", pending: "待人工" };
const MODE: Record<string, string> = { auto: "自动", manual: "人工" };

const RESULT_OPTIONS = [
  { value: "success", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "conditional", label: "有条件通过" },
];

interface LoadState {
  busy: boolean;
  error: string | null;
}

interface SaveState {
  busy: boolean;
  error: string | null;
  saved: BmfReleaseEvidenceSaved | null;
}

/**
 * M6 发布编排骨架。
 *
 * 自动部分只有「读文件、比对、检查」；发布、建表、验证、回滚都必须人做。
 * 因此这里**没有发布按钮**：`autoPublish` 恒为 false，官方入口确认并演练通过前不接通。
 */
export function MetaReleasePlan({
  path,
  component,
  module,
}: {
  path: string;
  component: string;
  module: string;
}) {
  const [plan, setPlan] = useState<BmfReleasePlan | null>(null);
  const [load, setLoad] = useState<LoadState>({ busy: true, error: null });
  const [result, setResult] = useState("");
  const [operator, setOperator] = useState("");
  const [note, setNote] = useState("");
  const [save, setSave] = useState<SaveState>({ busy: false, error: null, saved: null });

  const reload = useCallback(async () => {
    setLoad({ busy: true, error: null });
    try {
      setPlan(await bmfReleasePlan(path, component, module));
      setLoad({ busy: false, error: null });
    } catch (e) {
      setPlan(null);
      setLoad({ busy: false, error: String(e) });
    }
  }, [path, component, module]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const record = async () => {
    setSave({ busy: true, error: null, saved: null });
    try {
      const saved = await bmfReleaseEvidence(path, component, module, result, operator, note);
      setSave({ busy: false, error: null, saved });
    } catch (e) {
      setSave({ busy: false, error: String(e), saved: null });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("证据记录已复制", "success");
    } catch {
      toast("复制失败：剪贴板不可用", "error");
    }
  };

  return (
    <section className="meta-release" aria-label="发布编排">
      <div className="meta-release-bar">
        <span className="meta-section-title">发布编排（M6 骨架）</span>
        <span className="meta-release-badge" title="官方入口确认前不提供自动发布">
          不会自动发布
        </span>
        <Button size="sm" variant="outline" onClick={() => void reload()} disabled={load.busy}>
          <Icon name="refresh" size={13} /> 重新编排
        </Button>
      </div>

      {load.busy && <p className="meta-note">正在探测官方工具并生成步骤…</p>}
      {!load.busy && load.error && <p className="meta-error">编排失败：{load.error}</p>}

      {plan && !load.busy && (
        <>
          <p className="meta-note m-0">
            {plan.ready
              ? "前置检查通过，可按下面顺序人工执行。"
              : `${plan.blockers} 项阻断、${plan.warnings} 项待确认：先把阻断项解决。`}
            {plan.installCopy ? ` 安装目录已有同名组件，覆盖前先备份。` : " 安装目录没有同名组件：首次发布。"}
          </p>

          <div className="meta-release-block">
            <h5 className="meta-release-title">官方工具</h5>
            <div className="meta-tool-list">
              {plan.tools.map((t) => (
                <div key={t.id} className={`meta-tool is-${t.status}`}>
                  <span className={`meta-sev-dot sev-${t.status === "found" ? "ok" : t.status === "missing" ? "error" : "warn"}`} />
                  <strong>{t.label}</strong>
                  <span className="meta-tool-status">{TOOL_STATUS[t.status]}</span>
                  <span className="meta-tool-note">{t.path ?? t.note}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="meta-release-block">
            <h5 className="meta-release-title">步骤顺序</h5>
            <ol className="meta-step-list">
              {plan.steps.map((s, i) => (
                <li key={s.id} className={`meta-step is-${s.status}`}>
                  <span className="meta-step-index">{i + 1}</span>
                  <span className="meta-step-title">{s.title}</span>
                  <span className={`meta-step-mode is-${s.mode}`}>{MODE[s.mode]}</span>
                  <span className={`meta-step-status is-${s.status}`}>{STEP_STATUS[s.status]}</span>
                  <p className="meta-step-detail">{s.detail}</p>
                  <p className="meta-step-hint">{s.hint}</p>
                </li>
              ))}
            </ol>
          </div>

          <div className="meta-release-block">
            <h5 className="meta-release-title">证据记录</h5>
            <div className="meta-evidence">
              <label>
                发布结果
                <select
                  className="meta-ddl-conn"
                  aria-label="发布结果"
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                >
                  <option value="">请选择…</option>
                  {RESULT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                执行人
                <input
                  className="meta-ddl-conn"
                  aria-label="执行人"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                  placeholder="姓名或工号"
                />
              </label>
              <label className="meta-evidence-note">
                执行记录
                <textarea
                  className="meta-ddl-conn"
                  aria-label="执行记录"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="报错原文、VOMeta 抽查结果、截图位置、回滚演练…"
                />
              </label>
              <div className="meta-evidence-actions">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void record()}
                  disabled={save.busy || !result || !operator.trim()}
                >
                  {save.busy ? "记录中…" : "记录证据"}
                </Button>
                {save.saved && (
                  <Button size="sm" variant="ghost" onClick={() => void copy(save.saved!.content)}>
                    <Icon name="copy" size={13} /> 复制记录
                  </Button>
                )}
              </div>
              {save.error && <p className="meta-error">{save.error}</p>}
              {save.saved && (
                <p className="meta-note m-0">
                  已保存：<code>{save.saved.path}</code>（记录不代表发布已由工具执行）
                </p>
              )}
            </div>
            <details className="meta-release-template">
              <summary className="meta-release-title">证据模板（记录时自动填入计划与 SHA）</summary>
              <pre>{plan.evidenceTemplate}</pre>
            </details>
          </div>
        </>
      )}
    </section>
  );
}
