import { formatBytes, isMarkable, letterTone, type ChangeItem, type DiffResult } from "../../lib/svn";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import { copyText } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Menu, MenuItem } from "../ui/Menu";
import { SvnDiffEditor } from "./SvnDiffEditor";

export function svnDiffLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ java: "java", xml: "xml", sql: "sql", js: "javascript", ts: "typescript", tsx: "typescript", html: "html", css: "css", md: "markdown", ini: "ini", properties: "ini" } as Record<string, string>)[ext] ?? "plaintext";
}

export function DiffPane({ file, data, reviewed, onToggleReviewed, onOpenInEditor, onShowLog,
  onShowBlame, onMarkAndNext, onFocus, focused = false, disabled = false }: {
  file: ChangeItem;
  data: DiffResult;
  reviewed: boolean;
  onToggleReviewed: () => void;
  onOpenInEditor: () => void;
  onShowLog: () => void;
  onShowBlame: () => void;
  onMarkAndNext: () => void;
  onFocus?: () => void;
  focused?: boolean;
  disabled?: boolean;
}) {
  const root = useWorkspaceRoot();
  const markable = isMarkable(file);
  const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
  const dir = file.rel.includes("/") ? file.rel.slice(0, file.rel.lastIndexOf("/")) : "";
  return <section className="vc-main vc-local-diff">
    <SvnDiffEditor original={data.baseText} modified={data.workingText} language={svnDiffLanguage(file.path)} root={root}
      sourceKey={`local:${file.path.toLowerCase()}:r${file.revision}`} disabled={disabled}
      originalLabel={data.baseEmpty ? "无 BASE · 新文件" : `BASE r${file.revision > 0 ? file.revision : "?"}`}
      modifiedLabel={file.letter === "D" ? "工作副本 · 已删除" : "工作副本 · 只读"}
      toolbar={<div className="vc-diff-file" title={file.path}>
      <span className="vc-badge" data-st={letterTone(file.letter)} title={file.status}>{file.letter}</span>
      <b>{name}</b>{reviewed && <span aria-label="已审" title="已审"><Icon name="check" size={12} /></span>}
    </div>}
      actions={<>
        <button type="button" className="vc-btn vc-btn-sm vc-open-code" aria-label="在代码中打开" title="在代码中打开" onClick={onOpenInEditor}><Icon name="external" size={12} /><span>在代码中打开</span></button>
        {onFocus && !focused && <button type="button" className="vc-btn vc-btn-sm" aria-label="专注对比" title="专注对比" onClick={onFocus}><Icon name="panel" size={13} /><span className="vc-focus-label">专注对比</span></button>}
        <button type="button" className="vc-btn vc-btn-sm vc-btn-primary vc-review-next" title="标记已审并查看下一个 · Alt+↓" disabled={disabled || !markable} onClick={onMarkAndNext}><Icon name="check" size={12} /><span>已审并下一个</span></button>
        <Menu portal width="w-64" trigger={(open,toggle)=><button type="button" className="vc-btn vc-btn-sm" aria-label="当前文件更多操作" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={14}/></button>}>
          {close=><>
            <MenuItem label={reviewed ? "取消已审" : "标记已审"} icon="check" disabled={disabled || !markable} onClick={()=>{close();onToggleReviewed();}}/>
            <MenuItem label="历史" icon="history" onClick={()=>{close();onShowLog();}}/>
            <MenuItem label="逐行追溯" icon="user" onClick={()=>{close();onShowBlame();}}/>
            <MenuItem label="复制文件完整路径" icon="copy" onClick={()=>{close();void copyText(file.path,()=>toast("已复制文件路径","success"),e=>toast(`复制失败：${e}`,"error"));}}/>
            <div className="vc-file-info"><span>{dir || file.rel}</span><span>{data.encoding} · {data.eol} · {formatBytes(data.baseSize)} → {formatBytes(data.workingSize)}</span></div>
          </>}
        </Menu>
      </>} />
    {!data.editable && <p className="vc-reading-note" role="status">此内容无法无损保存，只读查看；请先处理编码或混合换行。</p>}
  </section>;
}
