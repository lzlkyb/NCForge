import { useMemo, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { friendlySvnError, formatRevTime, parseSvnError, svnRemoteStatus, type StatusResult, type SvnInfo, type SvnRemoteChange } from "../../lib/svn";
import { svnRevisionDiff } from "../../lib/svnHistory";
import { useSvnDraft } from "../../lib/svnDraft";
import { svnUnsavedUpdateFiles, type SvnUpdateOutcome } from "../../hooks/useSvnChanges";
import { setSideOpen } from "../../lib/layoutStore";
import { DockRegion } from "../workspace/WorkbenchDock";
import { Icon } from "../ui/icon";
import { TaskFeedback } from "../ui/TaskFeedback";
import { SvnDiffEditor } from "./SvnDiffEditor";
import { svnDiffLanguage } from "../../lib/svnDiffLanguage";

const names = { added: "新增", deleted: "删除", modified: "修改", replaced: "替换" } as const;
const listPage = 150;

interface Props {
  root: string;
  info?: SvnInfo;
  busy: string | null;
  conflicts: string[] | null;
  update: (revision: number, report: (outcome: SvnUpdateOutcome) => void) => Promise<void>;
  onConflict: (path: string) => void;
  onHistory: (revision: number) => void;
  onRefresh: () => Promise<StatusResult | undefined>;
  onAuth: () => void;
}

export function SvnRemote({ root, info, busy, conflicts, update, onConflict, onHistory, onRefresh, onAuth }: Props) {
  const qc = useQueryClient(), epoch = workspaceEpoch();
  const [selected, setSelected] = useState<string>();
  const [confirmed, setConfirmed] = useState<number>();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(listPage);
  const { lastCommit } = useSvnDraft(root);
  const unsavedCount = useWorkspaceSelector(() => svnUnsavedUpdateFiles(root).length);
  // A commit may advance individual working revisions without changing the root's revision.
  const previewKey = ["svn-remote-preview",root,epoch,lastCommit?.revision ?? 0];
  const outcomeKey = ["svn-remote-outcome",root];
  const preview = useQuery({ queryKey: previewKey, queryFn: () => svnRemoteStatus(root), enabled:false, retry:false });
  const { data: outcome } = useQuery<SvnUpdateOutcome | null>({ queryKey:outcomeKey, queryFn:skipToken });
  const data = preview.data, checked = !!data;
  const matches = useMemo(() => (data?.entries ?? []).filter(entry => entry.relativePath.toLowerCase().includes(search.trim().toLowerCase())),[data,search]);
  const item = data?.entries.find(change => change.relativePath === selected) ?? data?.entries[0];
  const currentOutcome = outcome && !preview.isFetching && (!data || outcome.result.revision >= data.revision) ? outcome : undefined;
  const remaining = currentOutcome?.conflicts == null ? currentOutcome?.conflicts : conflicts ?? currentOutcome.conflicts;
  const revision = data?.revision ?? 0;
  const detail = useQuery({
    queryKey:["svn-remote-diff",root,epoch,item?.repositoryPath,item?.baseRevision,revision],
    queryFn:() => svnRevisionDiff(item!.repositoryPath,revision,item!.baseRevision),
    enabled:!!item && !item.directory && revision > 0 && !busy,
    staleTime:Infinity, retry:false,
  });
  const check = () => {
    setConfirmed(undefined);
    void preview.refetch({cancelRefetch:false}).then(result => {
      if (result.isSuccess) qc.setQueryData(outcomeKey,null);
    });
  };
  const pick = (entry: SvnRemoteChange) => {
    setSelected(entry.relativePath);
    if (window.matchMedia?.("(max-width:640px)").matches) setSideOpen(false);
  };
  const startUpdate = () => {
    if (busy || preview.isFetching || !!preview.error || !data || confirmed !== revision || unsavedCount) return;
    setConfirmed(undefined);
    void update(revision, result => qc.setQueryData(outcomeKey,result));
  };
  const verify = () => void onRefresh().then(status => {
    if (status && currentOutcome) {
      const paths = status.changes.groups.flatMap(group => group.items).filter(entry => entry.letter === "C").map(entry => entry.path);
      qc.setQueryData(outcomeKey,{...currentOutcome,conflicts:paths});
    }
  });
  return <>
    <DockRegion region="toolbar"><div className="vc-head vc-remote-tools">
      <button type="button" className="vc-btn vc-btn-icon vc-files-toggle" aria-label="显示远端文件" onClick={() => setSideOpen(true)}><Icon name="panel" size={14}/></button>
      <span className="vc-hint" title={info?.url}>{info?.revision ? "工作副本 r" + info.revision : "工作副本"}</span>
      <span className="vc-sp"/>
      <button type="button" className="vc-btn" disabled={!root || preview.isFetching || !!busy} onClick={check}><Icon name={preview.isFetching ? "spinner" : "refresh"} className={preview.isFetching ? "animate-spin" : undefined} size={13}/>{preview.isFetching ? "检查中…" : "检查远端"}</button>
    </div></DockRegion>
    <DockRegion region="sidebar"><aside className="vc-chg">
      <div className="vc-chg-top"><div className="vc-list-title"><b>远端变更{checked ? " · " + data.total : ""}</b></div><span className="vc-hint">{info?.url ?? "当前工作副本"}</span>
        {(data?.entries.length ?? 0) > 50 && <div className="vc-search"><Icon name="search" size={13}/><input aria-label="筛选远端路径" placeholder="搜索已列出的远端路径" value={search} onChange={event => { setSearch(event.target.value); setLimit(listPage); }}/></div>}
      </div>
      <div className="vc-list" aria-label="远端文件">
        {matches.slice(0,limit).map(entry => <button type="button" className="vc-remote-row" aria-pressed={entry === item} key={entry.relativePath} onClick={() => pick(entry)}>
          <Icon name={entry.directory ? "folder" : "file"} size={15}/>
          <span><b>{entry.relativePath.split("/").pop()}</b><small title={entry.relativePath}>{names[entry.kind]}{entry.overlap ? " · 与本地重叠" : ""} · {entry.relativePath}</small></span>
        </button>)}
        {matches.length > limit && <div className="vc-chg-top"><button type="button" className="vc-btn" onClick={() => setLimit(value => value + listPage)}>显示更多路径 · {limit}/{matches.length}</button></div>}
        {search && !matches.length && <div className="vc-chg-top vc-hint">当前列表没有匹配路径。</div>}
        {data && data.total > data.entries.length && <div className="vc-chg-top vc-hint">显示前 {data.entries.length} 个路径，更新范围包含全部 {data.total} 个。</div>}
      </div>
      <div className="vc-chg-foot vc-hint">{checked ? "检查于 " + formatRevTime(preview.dataUpdatedAt) : "等待检查"}</div>
    </aside></DockRegion>
    <DockRegion region="document"><section className="vc-remote-doc">
      <TaskFeedback compact active={preview.isFetching || busy === "update"} operationKey={busy === "update" ? "update" : "check"} label={preview.isFetching ? "正在检查远端改动…" : currentOutcome ? "正在核对更新后的本地状态…" : "正在更新工作副本，等待服务器返回…"} />
      {preview.error && <div className="vc-alert" role="alert" data-tone="warn"><span>{friendlySvnError(preview.error)}</span>
        {parseSvnError(preview.error).code === "auth" && <button className="vc-btn" type="button" onClick={onAuth}>填写 SVN 账号</button>}
        <button className="vc-btn" type="button" disabled={preview.isFetching || !!busy} onClick={check}>重新检查</button></div>}
      {currentOutcome && <div className="vc-outcome" role="status" data-tone={remaining == null || !!remaining.length || !!currentOutcome.result.skipped ? "warn" : "ok"}>
        <Icon name="download" size={15}/><b>已更新到 r{currentOutcome.result.revision}</b>
        {currentOutcome.result.added != null && <span>新增 {currentOutcome.result.added} · 修改 {currentOutcome.result.modified} · 删除 {currentOutcome.result.deleted}{currentOutcome.result.skipped ? " · 跳过 " + currentOutcome.result.skipped : ""}</span>}
        <span>{remaining === undefined && busy === "update" ? "核对冲突中…" : remaining == null ? "尚未核对冲突" : remaining.length ? remaining.length + " 个冲突待处理" : "工作副本已核对"}</span>
        {remaining?.[0] && <button className="vc-btn" type="button" onClick={() => onConflict(remaining[0])}>处理冲突</button>}
        {remaining == null && busy !== "update" && <button className="vc-btn" type="button" onClick={verify}>重新核对</button>}
        <button className="vc-btn" type="button" onClick={() => onHistory(currentOutcome.result.revision)}>查看版本</button>
      </div>}
      {!checked && !preview.isFetching && !preview.error && !currentOutcome && <div className="vc-empty"><Icon name="download" size={24}/><b>检查仓库中的新改动</b><span>先查看受影响路径，再决定是否更新。</span>{root && <button type="button" className="vc-btn vc-btn-primary" disabled={!!busy} onClick={check}>检查远端</button>}</div>}
      {data && !data.total && !preview.isFetching && !currentOutcome && <div className="vc-empty"><Icon name="check" size={24}/><b>当前工作副本没有远端变更</b><span>已核对仓库 r{revision}</span></div>}
      {!!data?.total && <div className="vc-remote-layout">
        <div className="vc-remote-main">
          <div className="vc-bar"><b>更新预览</b><span className="vc-hint">根目录 r{data.baseRevision} · 仓库 r{revision}</span><span className="vc-sp"/>
            {!currentOutcome && confirmed !== revision && <button type="button" className="vc-btn vc-btn-primary" disabled={!!busy || preview.isFetching || !!preview.error || revision < 1} onClick={() => setConfirmed(revision)}>准备更新</button>}
          </div>
          {data.overlap > 0 && <div className="vc-alert" data-tone="warn"><Icon name="alertTriangle" size={14}/><span>{data.overlap} 个远端路径与检查时的本地改动重叠。</span></div>}
          {item && <div className="vc-bar"><b className="vc-remote-path">{item.relativePath}</b><span className="vc-sp"/><span className="vc-hint">{names[item.kind]}</span></div>}
          {item?.directory && <div className="vc-empty">目录无文件正文，更新会按所列路径处理。</div>}
          {detail.isFetching && <div className="vc-empty" role="status">正在读取版本正文…</div>}
          {detail.error && <div className="vc-alert" data-tone="warn"><span>{friendlySvnError(detail.error)}</span><button type="button" className="vc-btn" disabled={!!busy} onClick={() => void detail.refetch()}>重试读取</button></div>}
          {detail.data && <SvnDiffEditor original={detail.data.beforeText} modified={detail.data.afterText} sourceKey={`remote:${root}:${epoch}:${revision}:${item?.repositoryPath}`} root={root}
            language={svnDiffLanguage(detail.data.path,detail.data.afterText || detail.data.beforeText)} originalLabel={detail.data.beforeEmpty ? "基线中不存在" : "路径基线 r" + detail.data.beforeRevision} modifiedLabel={detail.data.afterEmpty ? "远端已删除" : "远端 r" + revision}/>}
        </div>
        {confirmed === revision && !currentOutcome && <aside className="vc-remote-confirm" aria-label="确认更新">
          <div className="vc-bar"><b>确认更新</b><span className="vc-sp"/><button type="button" className="vc-btn vc-btn-icon" aria-label="关闭更新确认" onClick={() => setConfirmed(undefined)}><Icon name="close" size={14}/></button></div>
          <p><b>整个工作副本 → r{revision}</b><br/>{data.total} 个远端路径 · {data.overlap} 个与本地重叠</p>
          <p className="vc-hint">更新会合并磁盘上的本地修改。本次范围不含外部引用。</p>
          {!!unsavedCount && <div className="vc-alert" data-tone="warn">请先保存 {unsavedCount} 个未保存文件。</div>}
          <div className="vc-commit-foot"><button type="button" className="vc-btn vc-btn-primary" disabled={!!busy || !!unsavedCount || !!preview.error || preview.isFetching} onClick={startUpdate}>更新工作副本</button></div>
        </aside>}
      </div>}
    </section></DockRegion>
  </>;
}
