import { errorToast } from "../../lib/errorToast";
import { useEffect, useState } from "react";
import { WorkspaceGlyph, type WorkspaceGlyphName } from "./WorkspaceGlyph";
import { invoke } from "../../lib/tauri";
import { baseName } from "../../lib/workspace";
import { failureText } from "../../lib/friendlyError";
import type { TreeRoot } from "../../lib/treeNav";

type Kind = "project" | "library" | "container" | "variable";
interface Dependency {
  kind: Kind;
  name: string;
  declared: string;
  path: string | null;
  status: "available" | "missing" | "unresolved" | "disabled";
  source: string | null;
  sourcePath: string | null;
}

const groups: Record<Kind, string> = {
  project: "工程引用", library: "外部库", container: "Eclipse 库容器", variable: "类路径变量",
};
const icons: Record<Kind, WorkspaceGlyphName> = { project: "project", library: "archive", container: "package", variable: "config" };
const statuses: Record<Dependency["status"], string> = {
  available: "可用", missing: "缺失", unresolved: "由 Eclipse 解析", disabled: "已停用",
};

export function PackageDependencies({ root, projects }: { root: string; projects: TreeRoot[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(root);
  const project = projects.some(p => p.path === selected) ? selected : root;
  return (
    <details className="wb-dependencies" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>依赖库</summary>
      {open && <div className="wb-dependencies-body">
        {projects.length > 1 && <label className="wb-dependency-project">工程
          <select value={project} onChange={e => setSelected(e.target.value)}>
            {projects.map(p => <option key={p.path} value={p.path} title={p.path}>{p.label ?? baseName(p.path)}</option>)}
          </select>
        </label>}
        <DependencyList key={project} project={project} />
      </div>}
    </details>
  );
}

function DependencyList({ project }: { project: string }) {
  const [entries, setEntries] = useState<Dependency[] | null>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void invoke<Dependency[] | null>("project_dependencies", { root: project }).then(
      rows => { if (active) setEntries(rows); },
      e => { if (active) setError(failureText("读取依赖库", e)); },
    );
    return () => { active = false; };
  }, [project, revision]);

  if (error) return <p role="alert">{error} <button type="button" onClick={() => { setError(""); setRevision(n => n + 1); }}>重试</button></p>;
  if (entries === undefined) return <p role="status">正在读取依赖库…</p>;
  if (entries === null) return <p>该工程没有 .classpath 文件。</p>;
  if (entries.length === 0) return <p>该工程未声明依赖。</p>;

  return <>
    <p className="wb-dependency-summary">共 {entries.length} 项 · 缺失 {entries.filter(e => e.status === "missing").length} 项</p>
    {(Object.keys(groups) as Kind[]).map(kind => {
      const rows = entries.filter(entry => entry.kind === kind);
      if (!rows.length) return null;
      const missing = rows.filter(entry => entry.status === "missing").length;
      return <details className="wb-dependency-group" key={kind}>
        <summary>{groups[kind]}（{rows.length}）{missing > 0 && <span className="wb-dependency-missing"> · 缺失 {missing} 项</span>}</summary>
        <ul>{rows.map((entry, index) => <li key={`${entry.declared}:${index}`}>
          <div className="wb-dependency-name">
            <WorkspaceGlyph name={icons[kind]} tone={kind === "library" ? "amber" : "slate"} />
            <strong>{entry.name}</strong><span data-status={entry.status}>{statuses[entry.status]}</span>
          </div>
          <div className="wb-dependency-path">{entry.path ?? entry.declared}</div>
          {entry.source && <div className="wb-dependency-path">源码 · {entry.sourcePath ?? `${entry.source}（未找到或无法解析）`}</div>}
          {entry.sourcePath && <button type="button" className="wb-dependency-locate" onClick={() => {
            void invoke("reveal_dependency_source", { root: project, path: entry.sourcePath })
              .catch(e => errorToast("定位源码", e));
          }}>定位源码</button>}
        </li>)}</ul>
      </details>;
    })}
  </>;
}
