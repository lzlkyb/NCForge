import { useCallback, useEffect, useRef, useState } from "react";
import {
  bmfGenApply,
  bmfGenDiff,
  bmfGeneratePlan,
  bmfValidate,
  type BmfArtifactStatus,
  type BmfGenApply,
  type BmfGenPlan,
  type BmfGenProfile,
  type BmfIssue,
} from "../../lib/bmf";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { GenArtifacts } from "./GenArtifacts";
import { GenConfigBar } from "./GenConfigBar";
import { MetaDdlRun } from "./MetaDdlRun";

const WRITE_LABEL: Record<string, string> = {
  written: "已写入",
  replaced: "已覆盖",
  skipped: "已跳过",
};

/** BMF 所在目录下的 `gen`：工作区内的默认落盘位置，用户可改。 */
function suggestDir(bmfPath: string): string {
  const dir = bmfPath.replace(/[\\/][^\\/]+$/, "");
  return dir ? `${dir}\\gen` : "";
}

/**
 * 生成中心（P0）：一次解析出全部产物图，配置即时预览，落盘前先看漂移。
 *
 * 性能口径（方案 §12）：解析 + 渲染在后端一次算完并回报分段耗时；这里不重复
 * 解析文件、不在前端拼内容，切产物只是切一段已渲染好的文本。
 */
export function MetaGenerate({ path, component }: { path: string; component?: string }) {
  const [profile, setProfile] = useState<BmfGenProfile | null>(null);
  const [plan, setPlan] = useState<BmfGenPlan | null>(null);
  const [statuses, setStatuses] = useState<Record<string, BmfArtifactStatus>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [root, setRoot] = useState(() => suggestDir(path));
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [diffMs, setDiffMs] = useState<number | null>(null);
  const [result, setResult] = useState<BmfGenApply | null>(null);
  const [issues, setIssues] = useState<BmfIssue[] | null>(null);
  const seq = useRef(0);

  const generate = useCallback(
    async (next: BmfGenProfile | null) => {
      const mine = ++seq.current;
      setBusy(true);
      setErr(null);
      setResult(null);
      try {
        // 校验与产物图并行：校验失败不影响预览（问题列表单独给），但 error 会挡住落盘。
        const [r, found] = await Promise.all([
          bmfGeneratePlan(path, next),
          bmfValidate(path).catch(() => null),
        ]);
        if (mine !== seq.current) return;
        setPlan(r);
        setIssues(found);
        setProfile(r.profile);
        // 注册清单默认不落盘：它是给「贴到别处」的辅助物，不是组件源码。
        setSelected(new Set(r.artifacts.filter((a) => a.kind !== "registry").map((a) => a.id)));
        setActiveId(r.artifacts[0]?.id ?? null);
      } catch (e) {
        if (mine !== seq.current) return;
        // 失败时清掉上一轮产物：否则用户会以为这些文件来自当前 BMF。
        setPlan(null);
        setProfile(next);
        setStatuses({});
        setActiveId(null);
        setIssues(null);
        setErr(String(e));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    },
    [path],
  );

  useEffect(() => {
    void generate(null);
  }, [generate]);

  const refreshDiff = useCallback(
    async (target: BmfGenPlan) => {
      const raw = root.trim();
      setDiffErr(null);
      if (!raw) {
        // 没有落盘根就谈不上漂移：不要给每个产物挂一个假的「新文件」。
        setStatuses({});
        setDiffMs(null);
        return;
      }
      try {
        const d = await bmfGenDiff(path, target.profile, undefined, raw);
        setStatuses(Object.fromEntries(d.items.map((i) => [i.id, i])));
        setDiffMs(d.timings.diffMs);
      } catch (e) {
        setStatuses({});
        setDiffMs(null);
        setDiffErr(String(e));
      }
    },
    [path, root],
  );

  useEffect(() => {
    if (plan) void refreshDiff(plan);
  }, [plan, refreshDiff]);

  const changeProfile = (next: BmfGenProfile) => {
    setProfile(next);
    void generate(next);
  };

  const pick = async () => {
    try {
      const dir = await pickFolder({ title: "选择生成物落盘目录", defaultPath: root || undefined });
      if (dir) setRoot(dir);
    } catch (e) {
      setErr(pickFolderError(e));
    }
  };

  const errorCount = issues?.filter((i) => i.severity === "error").length ?? 0;
  const warnCount = issues?.filter((i) => i.severity === "warn").length ?? 0;
  const blocked = errorCount > 0;

  const apply = async () => {
    if (!plan || !profile) return;
    if (blocked) {
      setErr("存在校验错误，先修复再落盘");
      return;
    }
    const raw = root.trim();
    if (!raw) {
      setErr("请先选择落盘目录");
      return;
    }
    setApplying(true);
    setErr(null);
    try {
      const r = await bmfGenApply(path, profile, undefined, raw, [...selected], force);
      setResult(r);
      if (r.written > 0) toast(`已写入 ${r.written} 个文件`, "success");
      else toast("没有需要写入的文件", "info");
      await refreshDiff(plan);
    } catch (e) {
      setResult(null);
      setErr(String(e));
    } finally {
      setApplying(false);
    }
  };

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
            onClick={() => void apply()}
            disabled={busy || applying || !plan || blocked}
            title={blocked ? "校验存在错误，先修复再落盘" : undefined}
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
          <GenConfigBar profile={profile} disabled={busy || applying} onChange={changeProfile} />

          {issues && (
            <p className={`meta-gen-check${blocked ? " is-bad" : ""}`}>
              规则校验：{errorCount} 错误 · {warnCount} 警告
              {blocked ? "；错误未清零前禁止落盘（先在「校验」页修复）" : ""}
            </p>
          )}

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
