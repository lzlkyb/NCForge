/**
 * 「按需求审查」里的一个文件分节：组头 + 可折叠的对比。
 *
 * 对比只在展开时挂 Monaco（一个需求常见 3–8 个文件，全展开也承受得住，但审完的自动折叠，
 * 滚动里同时存在的编辑器通常只有待审的那几个）。数据与「审查改动」右侧共用 react-query 缓存。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { SvnDiffEditor } from "./SvnDiffEditor";
import { svnDiffLanguage } from "./DiffPane";
import { isMarkable, letterTone, svnDiff, svnStatusLabel, type ChangeItem } from "../../lib/svn";
import { readFile } from "../../lib/workspace";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { statsIn } from "../../lib/blockState";
import { useSvnDiffPrefs } from "../../lib/svnDiffPrefs";
import { useBlockStrips } from "../../hooks/useBlockStrips";
import type { FileBlocks } from "../../hooks/useReqBlocks";

const LINE_PX = 19;

interface DiffBodyProps { it: ChangeItem; root: string; ctxReq: string | null; disabled: boolean; onFileReviewed: (all: boolean) => void }

function DiffBody(p: DiffBodyProps) {
  const { it, root } = p, epoch = workspaceEpoch(), isNew = it.letter === "?" || it.letter === "A";
  const diff = useQuery({ queryKey: ["svn-diff", root, epoch, it.path], queryFn: () => svnDiff(it.path), enabled: !isNew, retry: false });
  const created = useQuery({ queryKey: ["svn-new-file", root, epoch, it.path, it.letter, it.mtimeMs], queryFn: () => readFile(it.path), enabled: isNew, retry: false });
  const pair = isNew ? created.data && { original: "", modified: created.data.text } : diff.data && { original: diff.data.baseText, modified: diff.data.workingText };
  const error = isNew ? created.error : diff.error;
  if (error) return <div className="vc-alert" data-tone="warn"><Icon name="alert" size={14} /><span>取不到对比：{String(error)}</span></div>;
  if (!pair) return <div className="vc-rq-loading"><Icon name="spinner" size={14} className="animate-spin" />正在读取对比…</div>;
  return <DiffWithStrips {...p} original={pair.original} modified={pair.modified} isNew={isNew} />;
}

/** 拆成两层：标注条的 hook 要在对比内容到了之后才能调（hook 不能写在提前 return 之后）。 */
function DiffWithStrips({ it, root, ctxReq, disabled, onFileReviewed, original, modified, isNew }: DiffBodyProps & { original: string; modified: string; isNew: boolean }) {
  const onlyNew = useSvnDiffPrefs(root).onlyNew;
  const strip = useBlockStrips({ root, path: it.path, base: original, working: modified, ctxReq, disabled, onAllReviewed: onFileReviewed });
  const lines = Math.max(original.split("\n").length, modified.split("\n").length);
  // 短文件按实际行数（加上标注条）给高度，长文件封顶在视口 70%，内部自己滚动。
  const stripPx = strip.strips.reduce((sum, s) => sum + s.height, 0);
  const height = `min(70vh, ${Math.max(200, (lines + 4) * LINE_PX + stripPx)}px)`;
  return <div className="vc-rq-diff" style={{ height }}>
    <SvnDiffEditor original={strip.original} modified={modified} language={svnDiffLanguage(it.path)} root={root} strips={strip.strips}
      sourceKey={`req:${it.path.toLowerCase()}:r${it.revision}`} originalLabel={onlyNew ? "BASE + 已审的改动 · 只看新改动" : isNew ? "无 BASE · 新文件" : `BASE r${it.revision > 0 ? it.revision : "?"}`} modifiedLabel="工作副本 · 只读" />
  </div>;
}

export function ReqFileSection({ it, root, ctxReq, fb, done, mixedWith, disabled, onMark, onFileReviewed, onOpenFile }: {
  it: ChangeItem; root: string; fb?: FileBlocks; done: boolean;
  /** 在哪个需求里审（"-" = 未认领）。 */
  ctxReq: string | null;
  /** 也改过这个文件的其他需求名。 */
  mixedWith: string[];
  disabled: boolean;
  onMark: () => void;
  /** 在标注条上逐块审之后：本文件是否全部块都审了。 */
  onFileReviewed: (all: boolean) => void;
  onOpenFile: (path: string) => void;
}) {
  const stats = fb && statsIn(fb.infos, ctxReq);
  const [open, setOpen] = useState(!done);
  // 审完自动折叠；变回未审（内容又改了）自动展开。
  useEffect(() => { setOpen(!done); }, [done]);
  const name = it.rel.slice(it.rel.lastIndexOf("/") + 1), dir = it.rel.includes("/") ? it.rel.slice(0, it.rel.lastIndexOf("/")) : "";
  const canDiff = !it.isDir && it.letter !== "C" && it.letter !== "!" && it.letter !== "D";
  return <section className="vc-rq-file" data-file-key={it.path.toLowerCase()} data-done={done || undefined}>
    <div className="vc-rq-fhead">
      <button type="button" className="vc-rq-fold" aria-expanded={open} aria-label={open ? `折叠 ${name}` : `展开 ${name}`} onClick={() => setOpen(!open)}><Icon name={open ? "chevronDown" : "chevronRight"} size={12} /></button>
      <span className="vc-badge vc-badge-label" data-st={letterTone(it.letter)}>{svnStatusLabel[it.letter]}</span>
      <b title={it.path}>{name}</b>
      {mixedWith.length > 0 && <span className="vc-tag" data-tone="mix" title="出本需求的补丁会把别的需求对这个文件的改动一起带上线（NC 补丁整类替换）">也属于「{mixedWith.join("」「")}」</span>}
      <span className="vc-rq-dir">{dir}</span>
      <span className="vc-blocks" data-state={stats?.redo ? "redo" : done ? "done" : stats?.done ? "part" : undefined} title={stats?.redo ? `${stats.redo} 块审完后又改了（需重审）` : undefined}>{done && <Icon name="check" size={11} />}{stats ? `${stats.done}/${stats.total} 块` : done ? "已审" : "未审"}{done && !open ? " · 已折叠" : ""}</span>
      {!it.isDir && <button type="button" className="vc-btn vc-btn-sm" onClick={() => onOpenFile(it.path)}><Icon name="external" size={12} /><span>打开</span></button>}
      {!done && <button type="button" className="vc-btn vc-btn-sm" disabled={disabled || !isMarkable(it)} onClick={onMark} title={mixedWith.length && ctxReq !== "-" ? "只标本需求的改动块；别的需求的块留到那个需求里审" : undefined}><Icon name="check" size={12} /><span>本文件审完</span></button>}
    </div>
    {open && (canDiff ? <DiffBody it={it} root={root} ctxReq={ctxReq} disabled={disabled || !isMarkable(it)} onFileReviewed={onFileReviewed} /> : <p className="vc-rq-note">{it.letter === "D" ? "文件已删除。" : it.letter === "C" ? "有冲突，请到「审查改动」里处理。" : "没有可对比的内容。"}</p>)}
  </section>;
}
