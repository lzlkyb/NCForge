import { useState } from "react";
import { Icon } from "../ui/icon";
import type { ChangeItem } from "../../lib/svn";

type Choice = "mine" | "theirs" | "base";

const TAG: Record<Choice, string> = { mine: "我的", base: "基线", theirs: "服务器" };

/**
 * 冲突文件：只给「三选一 + 已解决」两步，不假装能做三路合并。
 *
 * 两步分开是刻意的：选一版 ≠ 你确认过内容。SVNKit 的 `resolve` 会连带删掉
 * `.mine` / `.rN` 三个临时文件，删了就没回头路，所以选择只记在本地 state，
 * 点「已解决」才真正落盘。
 */
export function ConflictPane({
  file,
  busy,
  onResolve,
  onOpenFile,
  onLater,
}: {
  file: ChangeItem;
  busy: boolean;
  onResolve: (choice: Choice) => void;
  onOpenFile: () => void;
  onLater: () => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);

  const row = (k: Choice, desc: string) => (
    <div className="vc-ver" key={k}>
      <span className="tag" data-k={k}>
        {TAG[k]}
      </span>
      <span className="p">{desc}</span>
      <span className="vc-sp" />
      {/* 「基线」这一行不给打开按钮：点它以前打开的是**冲突中的工作副本**
          （满屏 <<<<<<< 标记），而行描述写的是基线版本，两回事。
          想看基线的入口在仓里并不存在，与其给个名不副实的按钮，不如不给。 */}
      {k !== "base" && (
        <button
          type="button"
          className="vc-btn vc-btn-sm"
          data-on={choice === k || undefined}
          onClick={() => setChoice(k)}
        >
          {choice === k ? "已选作最终内容" : "用作最终内容"}
        </button>
      )}
    </div>
  );

  return (
    <section className="vc-main">
      <div className="vc-bar">
        <span className="vc-badge" data-st="conflict">
          C
        </span>
        <b>{name}</b>
        <span className="vc-sp" />
        <span className="vc-hint">
          {file.revision > 0 ? `本地基于 r${file.revision}` : "本地改动"} 与服务器版本冲突
        </span>
        <button
          type="button"
          className="vc-btn vc-btn-sm"
          onClick={onOpenFile}
          title="打开的是工作副本里这个文件——里面混着冲突标记，不是基线版本"
        >
          打开工作副本
        </button>
      </div>

      <div className="vc-conflict">
        <div className="vc-alert" data-tone="warn">
          <Icon name="alertTriangle" size={13} />
          <span>
            这个文件在服务器上也被改过，更新时没能自动合并。工作台不做三路合并——
            <b>挑一版</b>，剩下的差异到文件页手工粘。
          </span>
        </div>

        <div className="vc-ver-list">
          {row("mine", `${name}.mine — 你本地改完的内容`)}
          {row("base", `r${file.revision > 0 ? file.revision : "?"} — 你开始改之前的基线`)}
          {row("theirs", `${name}.r${file.revision > 0 ? file.revision : "?"} — 服务器上新提交的内容`)}
        </div>

        <div className="vc-alert" data-tone="info">
          <Icon name="info" size={13} />
          <span>
            点「已解决」才会用选中的版本覆盖工作副本、删掉 <code>.mine</code> / <code>.rN</code> 临时文件并解除冲突标记。
            落盘前会把这三个临时文件备份到工作副本旁边的 <code>.ncforge-resolve-&lt;时间戳&gt;</code> 目录，
            选错了能从这里找回来。
          </span>
        </div>
      </div>

      <div className="vc-commit-foot">
        <button type="button" className="vc-btn" disabled={busy} onClick={onLater}>
          稍后处理
        </button>
        <span className="vc-sp" />
        {choice === null && <span className="vc-hint">先在上面选一版</span>}
        <button
          type="button"
          className="vc-btn vc-btn-primary"
          disabled={busy || choice === null}
          onClick={() => choice && onResolve(choice)}
        >
          <Icon name="check" size={12} />
          {busy ? "处理中…" : "已解决"}
        </button>
      </div>
    </section>
  );
}
