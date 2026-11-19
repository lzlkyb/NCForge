import { useEffect, useRef, useState } from "react";
import { SelectionIndicator } from "../components/ui/SelectionIndicator";
import { useTabReflow } from "../hooks/useTabReflow";
import { Button } from "../components/ui/button";
import { Icon, type IconName } from "../components/ui/icon";
import { MOTION } from "../lib/motion";
import "../workspace.css";
import "../editor-groups.css";
import "./micro-workbench.css";

const initial = ["Account.java", "StockService.java", "CustomerVO.java"];
const pages: [string, IconName][] = [["代码", "code"], ["版本", "gitBranch"], ["数据库", "database"], ["元数据", "layers"], ["日志", "log"], ["设置", "settings"]];
const source = (name: string) => `public class ${name.replace(/\.java$/, "")} {\n\n    // 在这里输入，切换后草稿仍然保留。\n\n}`;

/** The shipped indicator and reflow hooks, with memory-only documents and no business operations. */
export function MicroWorkbenchPreview() {
  const rail = useRef<HTMLElement>(null), strip = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState("代码"), [files, setFiles] = useState(initial), [active, setActive] = useState(initial[0]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(true), [located, setLocated] = useState(false);
  const next = useRef(1);
  const signature = files.join("|");
  useTabReflow(strip, signature);
  useEffect(() => {
    if (!located) return;
    const timer = setTimeout(() => setLocated(false), MOTION.enter); return () => clearTimeout(timer);
  }, [located]);
  const close = (file: string) => {
    const kept = files.filter(name => name !== file);
    setFiles(kept);
    if (active === file) setActive(kept[Math.min(files.indexOf(file), kept.length - 1)] ?? "");
  };
  return <section className="rounded-xl border bg-card p-5" data-testid="micro-workbench-preview">
    <div className="micro-demo-heading"><div><h2 className="text-sm font-semibold">工作台连续操作</h2><p>切换页面与文件、关闭标签、展开目录；正文始终清晰可读。</p></div>
      <Button variant="outline" size="sm" onClick={() => { setFiles(initial); setActive(initial[0]); setPage("代码"); }}>恢复示例</Button></div>
    <div className="micro-demo app-shell">
      <aside className="app-side" ref={rail}>
        <SelectionIndicator container={rail} value={page} selector='[aria-current="page"]' />
        <nav className="app-side-nav" aria-label="示例页面">{pages.map(([label, icon]) => <button key={label} type="button" className="app-side-item" data-active={page === label || undefined}
          aria-current={page === label ? "page" : undefined} onClick={() => setPage(label)}><Icon name={icon} size={16} /><span>{label}</span></button>)}</nav>
      </aside>
      <div className="wb-editor-group-slot" data-focused>
        <div className="wb-tabs" role="tablist" aria-label="示例文件"><div ref={strip} className="wb-tabs-scroll">
          <SelectionIndicator container={strip} value={`${active}:${signature}`} selector='.wb-tab[data-active]' variant="tab" />
          {files.map(file => <div key={file} className="wb-tab" data-path={file} data-active={active === file || undefined} role="tab" aria-selected={active === file} tabIndex={active === file ? 0 : -1}
            onClick={() => setActive(file)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActive(file); } }}>
            <Icon name="code" size={13} /><span>{file}</span><button type="button" className="wb-tab-x" aria-label={`关闭示例 ${file}`} onClick={event => { event.stopPropagation(); close(file); }}><Icon name="close" size={12} /></button>
          </div>)}
        </div></div>
        <div className="micro-demo-toolbar"><span>{page} · {active || "尚未打开文件"}</span><Button variant="ghost" size="sm" onClick={() => { const file = `Draft${next.current++}.java`; setFiles([...files, file]); setActive(file); }}>新增标签</Button></div>
        <div className="micro-demo-body"><div className="micro-demo-tree" role="tree" aria-label="示例资源树">
          <button type="button" className="wb-row" role="treeitem" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Icon name="chevronRight" size={13} className="wb-row-disclosure" /><Icon name="folder" size={14} />src</button>
          {expanded && <div className="wb-tree-branch" data-enter>{files.map(file => <button key={file} type="button" role="treeitem" className="wb-row" data-active={active === file || undefined} data-located={located && active === file || undefined}
            onClick={() => setActive(file)}><Icon name="code" size={13} />{file}</button>)}</div>}
          <Button variant="ghost" size="sm" onClick={() => { setExpanded(true); setLocated(true); }}>定位当前文件</Button>
        </div><textarea aria-label="示例源码草稿" spellCheck={false} value={active ? drafts[active] ?? source(active) : ""} disabled={!active}
          onChange={event => setDrafts({ ...drafts, [active]: event.target.value })} /></div>
        <div className="micro-demo-status" role="status">仅交互示例，内容保留在内存中</div>
      </div>
    </div>
  </section>;
}
