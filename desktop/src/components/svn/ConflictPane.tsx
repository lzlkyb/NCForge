import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { useSvnWrite } from "../../lib/svnWrite";
import { svnConflictSnapshot, svnResolveWorking } from "../../lib/svnHistory";
import { friendlySvnError, type ChangeItem } from "../../lib/svn";
import { SvnDiffEditor } from "./SvnDiffEditor";
import { svnDiffLanguage } from "./DiffPane";
import "../../svn-history.css";
type Choice = "mine" | "theirs" | "base";
const tags: Record<Choice, string> = { mine: "我的内容", base: "基线内容", theirs: "服务器内容" };

export function ConflictPane({ file, busy, onResolve, onOpenFile, onLater }: { file: ChangeItem; busy: boolean; onResolve: (choice: Choice) => void; onOpenFile: () => void; onLater: () => void }) {
  const root = useWorkspaceRoot(); const epoch = workspaceEpoch(); const write = useSvnWrite(root); const qc = useQueryClient();
  const [choice, setChoice] = useState<Choice | null>(null); const [preview, setPreview] = useState<Choice>("mine"); const [saving, setSaving] = useState(false); const pending = useRef(false);
  const query = useQuery({ queryKey: ["svn-conflict-snapshot", root, epoch, file.path], queryFn: () => svnConflictSnapshot(file.path), retry: false });
  const data = query.data; const binary = !!data && [data.mine, data.base, data.theirs].some(version => version?.binary);
  const supported = !!data && data.textConflict && !data.treeConflict && !data.propertyConflict && !binary;
  const locked = busy || !!write || saving;
  const keepWorking = async () => {
    if (pending.current || locked) return; pending.current = true; setSaving(true);
    try {
      const result = await svnResolveWorking(file.path);
      toast(result.backupDir ? `合并结果已保留，备份位于 ${result.backupDir}` : "合并结果已保留", "success");
      await Promise.all([qc.invalidateQueries({ queryKey: ["svn-status"] }), qc.invalidateQueries({ queryKey: ["svn-diff"] }), qc.invalidateQueries({ queryKey: ["patch-changes"] }), qc.invalidateQueries({ queryKey: ["patch-scan"] })]);
      onLater();
    } catch (error) { toast(friendlySvnError(error), "error"); }
    finally { pending.current = false; setSaving(false); }
  };
  const viewed = data?.[preview];
  return <section className="vc-main vc-conflict-view">
    <div className="vc-bar"><span className="vc-badge" data-st="conflict">C</span><b>{file.rel}</b><span className="vc-sp" /><button className="vc-btn" disabled={locked} onClick={onOpenFile}>打开工作副本</button><button className="vc-btn" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" size={12} className={query.isFetching ? "animate-spin" : undefined} />刷新副本</button></div>
    {query.isLoading && <div className="vc-empty"><Icon name="spinner" className="animate-spin" />正在读取实际冲突版本…</div>}
    {query.error && <div className="vc-alert" data-tone="warn"><span>{friendlySvnError(query.error)}</span><button className="vc-btn" disabled={query.isFetching} onClick={() => void query.refetch()}>重试</button></div>}
    {data && <><div className="vc-conflict-notice vc-alert" data-tone={supported ? "info" : "warn"}>{data.treeConflict ? "这是树冲突，请在 SVN 客户端处理路径移动或删除关系。" : data.propertyConflict ? "包含属性冲突，请在 SVN 客户端处理属性后重新扫描。" : binary ? "这是二进制冲突，文本预览与手工合并不可用，请在 SVN 客户端处理。" : !data.textConflict ? "文本冲突已经解除，请刷新改动列表。" : "先核对真实副本，再选择最终内容。只有确认解决才会写入；写入前备份副本与当前工作文件。"}</div>
      <div className="vc-conflict-options">{(["mine", "base", "theirs"] as Choice[]).map(role => { const version = data[role]; return <div className="vc-conflict-option" key={role}><button className="vc-btn" data-on={preview === role || undefined} disabled={!version || version.binary} onClick={() => setPreview(role)}>{tags[role]}{version && version.revision > 0 ? ` · r${version.revision}` : ""}</button><span className="vc-hint" title={version?.name}>{version?.name ?? "无此副本"}</span><button className="vc-btn" aria-pressed={choice === role} disabled={locked || !supported || !version} onClick={() => setChoice(role)}>{choice === role ? "已选作最终内容" : "选作最终内容"}</button></div>; })}</div>
      {supported && viewed && data.base && <SvnDiffEditor original={data.base.text} modified={viewed.text} sourceKey={`conflict:${root}:${epoch}:${file.path}:${preview}`} root={root} language={svnDiffLanguage(file.path)} originalLabel={`基线 ${data.base.revision > 0 ? `r${data.base.revision}` : data.base.name}`} modifiedLabel={`${tags[preview]} ${viewed.revision > 0 ? `r${viewed.revision}` : viewed.name}`} />}
      <div className="vc-commit-foot"><button className="vc-btn" disabled={locked} onClick={onLater}>稍后处理</button><span className="vc-sp" /><button className="vc-btn" disabled={locked || !supported || !data.workingReadable || data.workingHasMarkers} onClick={() => void keepWorking()} title={data.workingHasMarkers ? "工作副本仍含冲突标记：先完成手工合并、保存并刷新副本" : "保留已保存的工作副本正文，备份后只解除文本冲突"}>{saving ? "验证与备份中…" : "保留手工合并结果"}</button><button className="vc-btn vc-btn-primary" disabled={locked || !supported || !choice || query.isFetching} onClick={() => choice && onResolve(choice)}>确认使用所选版本</button></div>
    </>}
  </section>;
}
