import { formatBytes, isMarkable, letterTone, type ChangeItem, type DiffResult } from "../../lib/svn";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import { copyText } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { SvnDiffEditor } from "./SvnDiffEditor";

export function svnDiffLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ java: "java", xml: "xml", sql: "sql", js: "javascript", ts: "typescript", tsx: "typescript", html: "html", css: "css", md: "markdown", ini: "ini", properties: "ini" } as Record<string, string>)[ext] ?? "plaintext";
}

export function DiffPane({ file, data, reviewed, onToggleReviewed, onOpenInEditor, onShowLog,
  onShowBlame, onMarkAndNext, picked, onTogglePicked, disabled = false }: {
  file: ChangeItem;
  data: DiffResult;
  reviewed: boolean;
  onToggleReviewed: () => void;
  onOpenInEditor: () => void;
  onShowLog: () => void;
  onShowBlame: () => void;
  onMarkAndNext: () => void;
  picked?: boolean;
  onTogglePicked?: () => void;
  disabled?: boolean;
}) {
  const root = useWorkspaceRoot();
  const markable = isMarkable(file);
  const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
  const dir = file.rel.includes("/") ? file.rel.slice(0, file.rel.lastIndexOf("/")) : "";
  return <section className="vc-main vc-local-diff">
    <div className="vc-file-title">
      <span className="vc-badge" data-st={letterTone(file.letter)} title={file.status}>{file.letter}</span>
      <div className="vc-file-name"><b>{name}</b><span title={file.path}>{dir || file.rel}</span></div>
      <button type="button" className="vc-btn vc-btn-sm" aria-label="复制文件完整路径" title={file.path}
        onClick={() => void copyText(file.path, () => toast("已复制文件路径", "success"), e => toast(`复制失败：${e}`, "error"))}><Icon name="copy" size={13} /></button>
      <span className="vc-sp" />
      <button type="button" className="vc-review-toggle" aria-pressed={reviewed} data-on={reviewed || undefined} disabled={disabled || !markable} onClick={onToggleReviewed}><Icon name="check" size={12} />{reviewed ? "已审" : "标记已审"}</button>
      {onTogglePicked && <button type="button" className="vc-btn vc-btn-sm" aria-pressed={picked ?? false} disabled={disabled} onClick={onTogglePicked}>{picked ? "已加入提交" : "加入提交"}</button>}
    </div>
    <div className="vc-file-actions">
      <span className="vc-hint">{data.encoding} · {data.eol} · {formatBytes(data.baseSize)} → {formatBytes(data.workingSize)}</span>
      <span className="vc-sp" />
      <button type="button" className="vc-btn vc-btn-sm" onClick={onShowLog}><Icon name="history" size={12} />历史</button>
      <button type="button" className="vc-btn vc-btn-sm" onClick={onShowBlame}><Icon name="user" size={12} />逐行追溯</button>
      <button type="button" className="vc-btn vc-btn-sm" onClick={onOpenInEditor}><Icon name="external" size={12} />在代码中打开</button>
    </div>
    <SvnDiffEditor original={data.baseText} modified={data.workingText} language={svnDiffLanguage(file.path)} root={root}
      sourceKey={`local:${file.path.toLowerCase()}:r${file.revision}`} disabled={disabled}
      originalLabel={data.baseEmpty ? "无 BASE · 新文件" : `BASE r${file.revision > 0 ? file.revision : "?"}`}
      modifiedLabel={file.letter === "D" ? "工作副本 · 已删除" : "工作副本 · 磁盘内容"}
      footer={<><span className="vc-sp" /><button type="button" className="vc-btn vc-btn-sm" disabled={disabled || !markable} onClick={onMarkAndNext}><Icon name="check" size={12} />已审并下一个</button></>} />
    <p className="vc-reading-note">{data.editable ? "差异只读，修改请在代码中打开。Alt+↓ 标记已审并查看下一个。" : "此内容无法无损保存，只读查看；请先处理编码或混合换行。"}</p>
  </section>;
}
