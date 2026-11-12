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
import type { FileBlocks } from "../../hooks/useReqBlocks";

const LINE_PX = 19;

function DiffBody({ it, root }: { it: ChangeItem; root: string }) {
  const epoch = workspaceEpoch(), isNew = it.letter === "?" || it.letter === "A";
  const diff = useQuery({ queryKey: ["svn-diff", root, epoch, it.path], queryFn: () => svnDiff(it.path), enabled: !isNew, retry: false });
  const created = useQuery({ queryKey: ["svn-new-file", root, epoch, it.path, it.letter, it.mtimeMs], queryFn: () => readFile(it.path), enabled: isNew, retry: false });
  const pair = isNew ? created.data && { original: "", modified: created.data.text } : diff.data && { original: diff.data.baseText, modified: diff.data.workingText };
  const error = isNew ? created.error : diff.error;
  if (error) return <div className="vc-alert" data-tone="warn"><Icon name="alert" size={14} /><span>取不到对比：{String(error)}</span></div>;
  if (!pair) return <div className="vc-rq-loading"><Icon name="spinner" size={14} className="animate-spin" />正在读取对比…</div>;
  const lines = Math.max(pair.original.split("\n").length, pair.modified.split("\n").length);
  // 短文件按实际行数给高度，长文件封顶在视口 70%，内部自己滚动。
  const height = `min(70vh, ${Math.max(200, (lines + 4) * LINE_PX)}px)`;
  return <div className="vc-rq-diff" style={{ height }}>
    <SvnDiffEditor original={pair.original} modified={pair.modified} language={svnDiffLanguage(it.path)} root={root}
      sourceKey={`req:${it.path.toLowerCase()}:r${it.revision}`} originalLabel={isNew ? "无 BASE · 新文件" : `BASE r${it.revision > 0 ? it.revision : "?"}`} modifiedLabel="工作副本 · 只读" />
  </div>;
}

export function ReqFileSection({ it, root, fb, done, mixedWith, disabled, onMark, onOpenFile }: {
  it: ChangeItem; root: string; fb?: FileBlocks; done: boolean;
  /** 也改过这个文件的其他需求名。 */
  mixedWith: string[];
  disabled: boolean;
  onMark: () => void;
  onOpenFile: (path: string) => void;
}) {
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
      <span className="vc-blocks" data-state={done ? "done" : fb?.done ? "part" : undefined}>{done && <Icon name="check" size={11} />}{fb ? `${fb.done}/${fb.blocks.length} 块` : done ? "已审" : "未审"}{done && !open ? " · 已折叠" : ""}</span>
      {!it.isDir && <button type="button" className="vc-btn vc-btn-sm" onClick={() => onOpenFile(it.path)}><Icon name="external" size={12} /><span>打开</span></button>}
      {!done && <button type="button" className="vc-btn vc-btn-sm" disabled={disabled || !isMarkable(it)} onClick={onMark}><Icon name="check" size={12} /><span>本文件审完</span></button>}
    </div>
    {open && (canDiff ? <DiffBody it={it} root={root} /> : <p className="vc-rq-note">{it.letter === "D" ? "文件已删除。" : it.letter === "C" ? "有冲突，请到「审查改动」里处理。" : "没有可对比的内容。"}</p>)}
  </section>;
}
