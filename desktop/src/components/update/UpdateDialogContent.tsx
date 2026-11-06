import { useId, useMemo, useState, type ReactNode } from "react";
import { APP_INFO } from "../../lib/about";
import { countReleaseItems, createUpdateNotesModel, type ReleaseContent, type UpdateNotesInfo } from "../../lib/updateNotes";
import { Icon } from "../ui/icon";
import { UpdateBrand } from "./UpdateBrand";
import { AVAILABLE_PROCESS, UpdateActions, UpdateProcess, updateProcessTitle, type UpdateDialogProcess } from "./UpdateProcess";
import "./update-dialog.css";

function formattedDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function textContent(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
  );
}

function ReleaseDetails({ content }: { content: ReleaseContent }) {
  return <div className="update-release-notes">
    {content.summary.map((text, index) => <p key={`summary-${index}`}>{textContent(text)}</p>)}
    {content.paragraphs.map((text, index) => <p key={`paragraph-${index}`}>{textContent(text)}</p>)}
    {content.groups.map(group => <section key={group.label}>
      <h4>{group.label}<span>{group.items.length}</span></h4>
      <ul>{group.items.map((text, index) => <li key={index}>{textContent(text)}</li>)}</ul>
    </section>)}
    {!content.groups.length && !content.summary.length && !content.paragraphs.length && content.highlights.map((text, index) => <p key={index}>{textContent(text)}</p>)}
  </div>;
}

function Disclosure({ label, children, secondary = false }: { label: string; children: ReactNode; secondary?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className={`update-disclosure${secondary ? " update-disclosure-history" : ""}`}>
    <button type="button" className="interactive update-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{label}</span><Icon name="chevronDown" size={14} aria-hidden="true" />
    </button>
    {/* Long histories mount only when requested; no per-row animation or continuous work. */}
    <div id={id} hidden={!open} className="update-disclosure-body">{open ? children : null}</div>
  </section>;
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
  const highlights = model?.highlights.slice(0, 3) ?? [];
  const cross = releases.length > 1;
  const date = formattedDate(latest?.date);
  const hasNotes = latest && (latest.groups.length || latest.summary.length || latest.paragraphs.length || latest.highlights.length);
  const blocked = process.preparing || process.restarting || process.status === "installing";
  return <>
    <button type="button" disabled={blocked} onClick={onClose} className="interactive update-close" aria-label="关闭更新弹窗"><Icon name="close" size={17} aria-hidden="true" /></button>
    <UpdateBrand currentVersion={update?.currentVersion} version={latest?.version} ready={process.status === "ready"} />
    <div className="update-dialog-main">
      <header className="update-dialog-header"><h2>{updateProcessTitle(process)}</h2><p>{date ? `${date}发布 · ` : ""}{APP_INFO.name} 软件更新</p></header>
      <div className="update-dialog-scroll" tabIndex={0} role="region" aria-label="更新内容与进度">
      <UpdateProcess process={process} />
      {model && <>
      <p className="update-scope-note">{cross ? `从你当前的版本起，汇总已收录的 ${releases.length} 个版本更新。` : "从当前版本升级，以下是本次值得关注的变化。"}</p>
      {model.total > 0 && <div className="update-stats"><span><strong>{model.total}</strong>项更新</span>{Object.entries(model.counts).map(([label, count]) => <span key={label}><strong>{count}</strong>{label}</span>)}</div>}
      {highlights.length > 0 && <section aria-label="升级亮点" className="update-benefits-section">
        <div className="update-benefits-heading"><h3>{cross ? "这次升级，值得关注的变化" : "本次更新亮点"}</h3><span>精选 {highlights.length} 项</span></div>
        <ul className="update-benefits">{highlights.map(({ version, text }) => {
          const plain = text.replace(/\*\*/g, "");
          // 摘要常写成一句带分号的话：前半句当卡片标题，后半句留作说明，避免整句挤进标题。
          const split = plain.search(/：|:\s|；/);
          const title = split < 0 ? plain : plain.slice(0, split);
          const description = split < 0 ? "" : plain.slice(split + 1).trim();
          return <li key={`${version}-${text}`}>
            <div className="update-benefit-title"><Icon name="sparkles" size={16} aria-hidden="true" /><h4>{title}</h4></div>
            {description && <p>{description}</p>}
            {cross && <span className="update-source-version">来自 <strong>v{version.replace(/^v/, "")}</strong></span>}
          </li>;
        })}</ul>
      </section>}
      {hasNotes && latest ? <Disclosure label={`本次发布${latest.version ? ` · v${latest.version}` : ""}${countReleaseItems(latest) ? ` · ${countReleaseItems(latest)} 条记录` : " · 更新说明"}`}>
        <ReleaseDetails content={latest} />
      </Disclosure> : <p className="update-empty">此版本未提供详细说明。</p>}
      {cross && <Disclosure secondary label={`查看跨版本完整记录${model.total ? ` · ${model.total} 条` : ""}`}>
        {releases.map(release => <article className="update-history-release" key={release.version}>
          <h3>v{release.version}<time>{formattedDate(release.date)}</time></h3>
          <ReleaseDetails content={release} />
        </article>)}
      </Disclosure>}
      </>}
      </div>
      <UpdateActions process={process} onClose={onClose} onDownload={onDownload} onDismiss={onDismiss} onRestart={onRestart} onRetry={onRetry} />
    </div>
  </>;
}
