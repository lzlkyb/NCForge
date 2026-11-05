import { useMemo } from "react";
import type { BmfArtifact, BmfArtifactStatus, BmfGenPlan } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

const FAMILY_LABEL: Record<string, string> = {
  java: "Java",
  db: "数据库脚本",
  bill: "单据",
  format: "打印/格式",
  meta: "注册清单",
};

const STATUS_LABEL: Record<string, string> = {
  new: "新文件",
  unchanged: "已一致",
  outdated: "待更新",
  modified: "已手改",
  conflict: "冲突",
  orphan: "已废弃",
};

const KIND_LABEL: Record<string, string> = {
  vo: "VO",
  enum: "枚举",
  aggvo: "聚合VO",
  selvo: "查询VO",
  bean: "Bean接口",
  beanItf: "Bean接口",
  op: "组件接口",
  opItf: "组件接口",
  test: "JUnit",
  ddl: "DDL",
  registry: "注册",
};

function ms(v: number | undefined): string {
  if (v == null) return "—";
  return v >= 10 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`;
}

interface Props {
  plan: BmfGenPlan;
  statuses: Record<string, BmfArtifactStatus>;
  selected: Set<string>;
  activeId: string | null;
  diffMs: number | null;
  onToggle: (id: string) => void;
  onSelectAll: (all: boolean) => void;
  onActive: (id: string) => void;
}

/** 产物图：左侧清单（按族分组 + 漂移状态），右侧预览。 */
export function GenArtifacts({
  plan,
  statuses,
  selected,
  activeId,
  diffMs,
  onToggle,
  onSelectAll,
  onActive,
}: Props) {
  const groups = useMemo(() => {
    const out: Array<{ family: string; items: BmfArtifact[] }> = [];
    for (const a of plan.artifacts) {
      const g = out.find((x) => x.family === a.family);
      if (g) g.items.push(a);
      else out.push({ family: a.family, items: [a] });
    }
    return out;
  }, [plan]);

  const active = plan.artifacts.find((a) => a.id === activeId) ?? plan.artifacts[0];
  const allSelected = selected.size === plan.artifacts.length;

  const copy = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.text);
      toast("内容已复制", "success");
    } catch {
      toast("复制失败：剪贴板不可用", "error");
    }
  };

  return (
    <div className="meta-gen-center">
      <div className="meta-gen-timing">
        <span>
          解析 <b>{ms(plan.timings.parseMs)}</b>
        </span>
        <span>
          图 <b>{ms(plan.timings.graphMs)}</b>
        </span>
        <span>
          渲染 <b>{ms(plan.timings.renderMs)}</b>
        </span>
        <span>
          对比 <b>{ms(diffMs ?? undefined)}</b>
        </span>
        <span className="is-total">
          合计 <b>{ms(plan.timings.totalMs)}</b>
        </span>
        <span className="meta-gen-budget">预算 10s</span>
      </div>

      <div className="meta-gen-split">
        <div className="meta-gen-list">
          <div className="meta-gen-list-head">
            <span>
              {plan.artifacts.length} 个产物 · 已选 {selected.size}
            </span>
            <button type="button" onClick={() => onSelectAll(!allSelected)}>
              {allSelected ? "全不选" : "全选"}
            </button>
          </div>
          {groups.map((g) => (
            <section key={g.family}>
              <h4>{FAMILY_LABEL[g.family] ?? g.family}</h4>
              {g.items.map((a) => {
                const st = statuses[a.id];
                return (
                  <div
                    key={a.id}
                    className={`meta-gen-item${a.id === active?.id ? " is-active" : ""}`}
                    onClick={() => onActive(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onActive(a.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    title={a.pathHint}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => onToggle(a.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择 ${a.name}`}
                    />
                    <span className="meta-gen-kind">{KIND_LABEL[a.kind] ?? a.kind}</span>
                    <span className="meta-gen-name">{a.name}</span>
                    {st && (
                      <span className={`meta-gen-status is-${st.status}`} title={st.detail}>
                        {STATUS_LABEL[st.status] ?? st.status}
                      </span>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <div className="meta-gen-preview">
          {active ? (
            <>
              <div className="meta-gen-preview-head">
                <code>{active.pathHint}</code>
                <span>
                  {active.encoding} / {active.eol}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void copy()}>
                  <Icon name="copy" size={13} /> 复制
                </Button>
              </div>
              <pre className="meta-code">{active.text || "（没有内容）"}</pre>
            </>
          ) : (
            <p className="meta-note">没有可预览的产物。</p>
          )}
        </div>
      </div>
    </div>
  );
}
