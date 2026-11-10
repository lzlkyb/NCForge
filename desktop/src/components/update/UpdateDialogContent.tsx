import { useMemo, useRef, useState } from "react";
import { groupReleaseItems } from "../../lib/releaseReading";
import { ReleaseItem } from "../settings/ReleaseItem";
import { ReleaseText } from "../settings/ReleaseText";
import { APP_INFO } from "../../lib/about";
import { createUpdateNotesModel, type ReleaseContent, type UpdateNotesInfo } from "../../lib/updateNotes";
import { Icon } from "../ui/icon";
import { UpdateBrand } from "./UpdateBrand";
import { AVAILABLE_PROCESS, UpdateActions, UpdateProcess, updateProcessTitle, type UpdateDialogProcess } from "./UpdateProcess";
import "../settings/settings-about.css";
import "./update-dialog.css";

function formattedDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function ReleaseDetails({ content }: { content: ReleaseContent }) {
  return <div className="update-release-notes">
    {content.summary.map((text, index) => <p key={`summary-${index}`}><ReleaseText text={text} /></p>)}
    {content.paragraphs.map((text, index) => <p key={`paragraph-${index}`}><ReleaseText text={text} /></p>)}
    {groupReleaseItems(content.groups.flatMap(group => group.items.map(text => ({label:group.label,text})))).map(group => <section key={group.label}>
      <h4>{group.label}<span>{group.items.length}</span></h4>
      <ul>{group.items.map((text, index) => <li key={index}><ReleaseItem text={text} /></li>)}</ul>
    </section>)}
    {!content.groups.length && !content.summary.length && !content.paragraphs.length && content.highlights.map((text, index) => <p key={index}><ReleaseText text={text} /></p>)}
  </div>;
}

export function UpdateDialogContent({ update, process = AVAILABLE_PROCESS, onClose, onDownload, onDismiss, onRestart, onRetry }: {
  update: UpdateNotesInfo | null;
  process?: UpdateDialogProcess;
  onClose: () => void;
  onDownload: () => void;
  onDismiss: () => void;
  onRestart?: () => void;
  onRetry?: () => void;
}) {
  const model = useMemo(() => update ? createUpdateNotesModel(update) : null, [update]);
  const latest = model?.latest;
  const releases = model?.releases ?? [];
  const highlights = model?.highlights ?? [];
  const [view, setView] = useState<"highlights" | "records">("highlights");
  const [query, setQuery] = useState("");
  const scrollHost = useRef<HTMLDivElement>(null);
  const changeView = (next: "highlights" | "records") => {
    setView(next);
    if (scrollHost.current) scrollHost.current.scrollTop = 0;
  };
  const needle = query.trim().toLocaleLowerCase();
  const filtered = releases.map(release => ({ ...release,
    summary: release.summary.filter(text => text.toLocaleLowerCase().includes(needle)),
    paragraphs: release.paragraphs.filter(text => text.toLocaleLowerCase().includes(needle)),
    highlights: release.highlights.filter(text => text.toLocaleLowerCase().includes(needle)),
    groups: release.groups.map(group => ({...group, items:group.items.filter(text => text.toLocaleLowerCase().includes(needle))})).filter(group => group.items.length),
  })).filter(release => release.groups.length || release.summary.length || release.paragraphs.length || release.highlights.length);
  const cross = releases.length > 1;
  const date = formattedDate(latest?.date);
  const blocked = process.preparing || process.restarting || process.status === "installing";
  return <>
    <button type="button" disabled={blocked} onClick={onClose} className="interactive update-close" aria-label="关闭更新弹窗"><Icon name="close" size={17} aria-hidden="true" /></button>
    <UpdateBrand currentVersion={update?.currentVersion} version={latest?.version} ready={process.status === "ready"} />
    <div className="update-dialog-main">
      <header className="update-dialog-header"><h2>{updateProcessTitle(process)}</h2><p>{date ? `${date}发布 · ` : ""}{APP_INFO.name} 软件更新</p></header>
      {model && <div className="update-content-nav" role="group" aria-label="更新内容视图">
        <button type="button" aria-pressed={view === "highlights"} onClick={() => changeView("highlights")}>更新亮点 <span>{highlights.length}</span></button>
        <button type="button" aria-pressed={view === "records"} onClick={() => changeView("records")}>完整记录 <span>{model.total}</span></button>
      </div>}
      <div ref={scrollHost} className="update-dialog-scroll" tabIndex={0} role="region" aria-label="更新内容与进度">
      <UpdateProcess process={process} />
      {model && <>
      <p className="update-scope-note">{cross ? `从你当前的版本起，汇总已收录的 ${releases.length} 个版本更新。` : "从当前版本升级，以下是本次值得关注的变化。"}</p>
      {model.total > 0 && <div className="update-stats"><span><strong>{model.total}</strong>项更新</span>{Object.entries(model.counts).map(([label, count]) => <span key={label}><strong>{count}</strong>{label}</span>)}</div>}
      {view === "highlights" && highlights.length > 0 && <section aria-label="升级亮点" className="update-benefits-section">
        <div className="update-benefits-heading"><h3>{cross ? "这次升级，值得关注的变化" : "本次更新亮点"}</h3><span>精选 {highlights.length} 项</span></div>
        <ul className="update-benefits">{highlights.map(({ version, text }) => {
          return <li key={`${version}-${text}`}>
            <ReleaseItem text={text} />
            {cross && <span className="update-source-version">来自 <strong>v{version.replace(/^v/, "")}</strong></span>}
          </li>;
        })}</ul>
      </section>}
      {view === "highlights" && <>
        {!highlights.length && <p className="update-empty">此版本未单独提供亮点，请查看完整记录。</p>}
        <button type="button" className="update-all-records" onClick={() => changeView("records")}>查看全部更新记录{model.total ? ` · ${model.total} 条` : ""}<Icon name="arrowRight" size={14} aria-hidden="true" /></button>
      </>}
      {view === "records" && <>
        <label className="update-record-search"><Icon name="search" size={15} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索功能、修复或关键词" aria-label="搜索更新记录" />{query && <button type="button" aria-label="清空更新搜索" onClick={() => setQuery("")}><Icon name="close" size={14} /></button>}</label>
        <span className="update-search-status" role="status">{needle ? `找到 ${filtered.length} 个版本的匹配内容` : `共 ${releases.length} 个版本，按功能分组阅读`}</span>
        {!filtered.length && <p className="update-empty">{needle ? "没有匹配的更新记录，请换个关键词。" : "此版本未提供详细说明。"}</p>}
        {filtered.map(release => <article className="update-history-release" key={release.version}>
          <h3>v{release.version}<time>{formattedDate(release.date)}</time></h3>
          <ReleaseDetails content={release} />
        </article>)}
      </>}
      </>}
      </div>
      <UpdateActions process={process} onClose={onClose} onDownload={onDownload} onDismiss={onDismiss} onRestart={onRestart} onRetry={onRetry} />
    </div>
  </>;
}
