import { useEffect, useState } from "react";
import { useMetaGeneration } from "../../hooks/useMetaGeneration";

import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

import { GenArtifacts } from "./GenArtifacts";
import { GenConfigBar } from "./GenConfigBar";
import { MetaDdlRun } from "./MetaDdlRun";

const WRITE_LABEL: Record<string, string> = {
  written: "已写入",
  replaced: "已覆盖",
  skipped: "已跳过",
};


/**
 * 生成中心（P0）：一次解析出全部产物图，配置即时预览，落盘前先看漂移。
 *
 * 性能口径（方案 §12）：解析 + 渲染在后端一次算完并回报分段耗时；这里不重复
 * 解析文件、不在前端拼内容，切产物只是切一段已渲染好的文本。
 */
export function MetaGenerate({ path, component }: { path: string; component?: string }) {
  const gen = useMetaGeneration(path);
  const { profile, plan, statuses, root, force, busy, applying, err, diffErr, diffMs, result, issues, generate, pick, setRoot, setForce } = gen;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    setSelected(new Set(plan?.artifacts.filter((a) => a.kind !== "registry").map((a) => a.id) ?? []));
    setActiveId(plan?.artifacts[0]?.id ?? null);
  }, [plan]);
  const errorCount = issues?.filter((i) => i.severity === "error").length ?? 0;
  const warnCount = issues?.filter((i) => i.severity === "warn").length ?? 0;
  const blocked = issues === null || errorCount > 0;
  const active = plan?.artifacts.find((a) => a.id === activeId);

  return (
    <div className="meta-gen-view">
      <div className="meta-gen-bar">
        <span className="meta-gen-title">生成中心</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void generate(profile)}
            disabled={busy || applying}
          >
            <Icon name="refresh" size={13} /> 重新生成
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void gen.apply(selected)}
            disabled={busy || applying || !plan || blocked}
            title={blocked ? "先完成规则校验并修复错误，再落盘" : undefined}
          >
            <Icon name="download" size={13} /> {applying ? "写入中…" : "写入磁盘"}
          </Button>
        </div>
      </div>

      {err && <p className="meta-error">{err}</p>}
      {diffErr && <p className="meta-error">漂移对比失败：{diffErr}</p>}
      {busy && <p className="meta-note">正在生成…</p>}

      {profile && plan && (
        <>
          <GenConfigBar profile={profile} disabled={busy || applying} onChange={(next) => void generate(next)} />

          {issues && (
            <p className={`meta-gen-check${blocked ? " is-bad" : ""}`}>
              规则校验：{errorCount} 错误 · {warnCount} 警告
              {blocked ? "；错误未清零前禁止落盘（先在「校验问题」中修复）" : ""}
            </p>
          )}
          {issues === null && !busy && <p className="meta-error">规则校验未完成，请重新生成后再落盘。</p>}

          {plan.warnings.length > 0 && (
            <div className="meta-warn-box">
              {plan.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          <div className="meta-export">
            <div className="meta-export-row">
              <span className="meta-export-label">
                <Icon name="download" size={12} /> 落盘到
              </span>
              <input
                className="meta-export-input"
                value={root}
                disabled={applying}
                onChange={(e) => setRoot(e.target.value)}
                placeholder="工作区内的目录，如 D:\proj\gen"
                aria-label="生成物落盘目录"
                spellCheck={false}
              />
              <Button size="sm" variant="ghost" onClick={() => void pick()} disabled={applying}>
                选择…
              </Button>
              <label className="meta-gen-opt" title="只对「生成后被手改」的文件生效；覆盖前会备份">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  disabled={applying}
                />
                覆盖已手改文件（先备份）
              </label>
            </div>
            <p className="meta-note">
              只写选中且允许写的产物；工作区外路径会被拒绝。不执行 SQL，不改 NC 安装目录。
            </p>
          </div>

          <GenArtifacts
            plan={plan}
            statuses={statuses}
            selected={selected}
            activeId={activeId}
            diffMs={diffMs}
            onToggle={(id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelectAll={(all) =>
              setSelected(all ? new Set(plan.artifacts.map((a) => a.id)) : new Set())
            }
            onActive={setActiveId}
          />

          {active?.kind === "ddl" && (
            <MetaDdlRun ddl={active.text} component={component || componentOf(path)} />
          )}

          {result && (
            <div className="meta-export-result">
              <p>
                已写入 <strong>{result.written}</strong> 个
                {result.skipped > 0 && <>，跳过 <strong>{result.skipped}</strong> 个</>}
                {result.manifest && (
                  <>
                    ；清单：<code>{result.manifest}</code>
                  </>
                )}
              </p>
              <ul>
                {result.items.map((it) => (
                  <li key={it.relPath} className={`is-${it.status}`}>
                    <span>{WRITE_LABEL[it.status] ?? it.status}</span>
                    <code>{it.relPath}</code>
                    {it.status === "skipped" && <em>{it.detail}</em>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function componentOf(path: string): string {
  return path.replace(/^.*[\\/]/, "").replace(/\.bmf$/i, "");
}
