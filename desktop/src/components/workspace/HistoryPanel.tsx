// 「本地历史」弹层：当前文件的历史版本列表 + 与磁盘现状的差异 + 恢复。
//
// 为什么是弹层而不是常驻侧栏：同「文件结构」——编辑器横向空间紧张，历史是
// 「出事才看」的功能，常驻不划算。
//
// 三条口径（改前想清楚）：
// 1. diff 比的是**磁盘现状**，不是编辑器里没保存的内容——恢复写的是磁盘。
//    文件有未保存修改时禁用恢复并说明原因，避免「恢复了但没保存的又写回去」。
// 2. 恢复是破坏性操作，但后端会先把当前内容归档一版，所以确认框里敢承诺
//    「可再退回来」。确认分两步（按钮变「确认恢复？」），不借 ConfirmDialog：
//    那个是模态的，这里只是弹层里的一小块。
// 3. 恢复后父组件负责重载文件（mtime 变了，编辑器模型必须跟着刷新）。
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { readFile, type FileContent } from "../../lib/workspace";
import { formatBytes } from "../../lib/utils";
import {
  listLocalHistory,
  readLocalHistory,
  restoreLocalHistory,
  type HistoryVersion,
  type VersionPreview,
} from "../../lib/localHistory";
import { formatHistoryTime } from "../../lib/historyFormat";
import { collapseDiff, countChanges, diffLines } from "../../lib/textDiff";

interface Props {
  open: boolean;
  onClose: () => void;
  path: string | null;
  /** 文件有未保存修改：禁用恢复（先保存或还原） */
  dirty: boolean;
  /** 恢复成功后调用（父组件重载文件） */
  onRestored: (path: string) => void;
}

/** diff 最多渲染这么多行（折叠后通常远少于这个数；防超大文件卡死渲染）。 */
const MAX_DIFF_ITEMS = 400;

/** readFile 会把换行归一成 \n，历史版本是原字节——比之前必须两边都归一，否则 CRLF 文件每行都像改过。 */
const norm = (s: string) => s.replace(/\r\n/g, "\n");

export function HistoryPanel({ open, onClose, path, dirty, onRestored }: Props) {
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const [current, setCurrent] = useState<FileContent | null>(null);
  const [phase, setPhase] = useState<"idle" | "confirm" | "restoring">("idle");
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // phase / onClose 的活引用：Esc 与外点监听只在开屏时注册一次（不新增 effect，
  // 组件 hook 数已到门禁上限），用 ref 穿透闭包读最新值
  const live = useRef({ phase, onClose });
  live.current = { phase, onClose };

  // 打开时：版本列表 + 磁盘现状（diff 的右侧、恢复的 mtime 基准）
  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    setVersions(null);
    setSel(null);
    setPreview(null);
    setError(null);
    setPhase("idle");
    void Promise.all([listLocalHistory(path), readFile(path)])
      .then(([vs, fc]) => {
        if (!alive) return;
        setVersions(vs);
        setCurrent(fc);
      })
      .catch((e) => alive && setError(String(e)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // 恢复写盘中不关：关了用户就不知道结果了
      if (live.current.phase !== "restoring") live.current.onClose();
    };
    // 点面板外面关。挂 document 而不是全屏遮罩：遮罩会盖住整个编辑区，
    // 想滚动代码、点别处对照都会被它吃掉。触发按钮（data-popover="history"）排除——
    // 那是开关，交给外层 toggle，否则「点按钮关」会变成先关再开、像点了没反应。
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!t) return;
      if (panelRef.current?.contains(t as Node)) return;
      if ((t as Element).closest?.('[data-popover="history"]')) return;
      // 恢复写盘中不关：关了用户就不知道结果了
      if (live.current.phase !== "restoring") live.current.onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, path]);

  // 选中某版时读它的内容
  useEffect(() => {
    if (!open || !path || !sel) return;
    let alive = true;
    setPreview(null);
    readLocalHistory(path, sel)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [open, path, sel]);

  if (!open || !path) return null;

  const doRestore = async () => {
    if (!sel || !current) return;
    setPhase("restoring");
    setError(null);
    try {
      await restoreLocalHistory(path, sel, current.mtimeMs);
      toast("已恢复历史版本", "success");
      onRestored(path);
      // 恢复前后端会把「恢复前的内容」也归档一版，列表和磁盘快照都要重取
      const [vs, fc] = await Promise.all([listLocalHistory(path), readFile(path)]);
      setVersions(vs);
      setCurrent(fc);
      setSel(null);
      setPreview(null);
      setPhase("idle");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  };

  const diff =
    preview?.text != null && current
      ? diffLines(norm(preview.text), norm(current.text))
      : null;
  const changes = diff ? countChanges(diff.rows) : null;
  const items = diff && !diff.tooBig ? collapseDiff(diff.rows).slice(0, MAX_DIFF_ITEMS) : [];

  return (
    <div ref={panelRef} className="wb-hist" role="dialog" aria-label="本地历史">
    <div className="wb-hist-head">
        <Icon name="clock" size={13} />
        <span>本地历史</span>
        <span className="wb-hist-count">{versions ? `${versions.length} 版` : ""}</span>
        <button
          type="button"
          className="wb-hist-x"
          title={phase === "restoring" ? "恢复进行中，不能关闭" : "关闭"}
          aria-label="关闭"
          disabled={phase === "restoring"}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="wb-hist-list">
        {versions === null && !error && <div className="wb-hist-note">加载中…</div>}
        {versions === null && error && <div className="wb-hist-error">{error}</div>}
        {versions !== null && versions.length === 0 && (
          <div className="wb-hist-note">还没有历史版本。保存、切换文件时会自动归档。</div>
        )}
        {versions?.map((v) => (
          <button
            type="button"
            key={v.id}
            className="wb-hist-row"
            data-active={v.id === sel || undefined}
            onClick={() => {
              setSel(v.id);
              setError(null);
              setPhase("idle");
            }}
          >
            <span className="wb-hist-time" title={formatHistoryTime(v.ts).title}>
              {formatHistoryTime(v.ts).label}
            </span>
            <span className="wb-hist-size">{formatBytes(v.size)}</span>
          </button>
        ))}
      </div>

      {sel && (
        <div className="wb-hist-detail">
          {preview === null && !error && <div className="wb-hist-note">读取中…</div>}
          {preview?.truncated && (
            <div className="wb-hist-note">这一版有 {formatBytes(preview.size)}，太大不做对比，可直接恢复。</div>
          )}
          {diff && changes && (
            <div className="wb-hist-diffhead">
              <span>与当前磁盘内容的差异</span>
              <span className="wb-hist-changes">
                <em className="wb-hist-add">+{changes.added}</em>
                <em className="wb-hist-del">−{changes.removed}</em>
              </span>
            </div>
          )}
          {diff?.tooBig && <div className="wb-hist-note">差异太大，只显示版本大小，可直接恢复。</div>}
          <div className="wb-hist-diff">
            {items.map((it, i) =>
              it.kind === "gap" ? (
                <div key={`g${i}`} className="wb-hist-gap">
                  ⋯ {it.count} 行相同 ⋯
                </div>
              ) : (
                <div key={`r${i}`} className={`wb-hist-line wb-hist-${it.row.op}`}>
                  <span className="wb-hist-ln">{it.row.oldLine ?? it.row.newLine ?? ""}</span>
                  <span className="wb-hist-sign">
                    {it.row.op === "add" ? "+" : it.row.op === "del" ? "−" : " "}
                  </span>
                  <span className="wb-hist-text">{it.row.text}</span>
                </div>
              ),
            )}
          </div>

          <div className="wb-hist-actions">
            {dirty ? (
              <span className="wb-hist-warn">文件有未保存的修改，先保存或还原后再恢复历史版本</span>
            ) : phase === "idle" ? (
              <button type="button" className="wb-hist-restore" onClick={() => setPhase("confirm")}>
                <Icon name="restore" size={12} />
                恢复此版本
              </button>
            ) : phase === "confirm" ? (
              <>
                <button type="button" className="wb-hist-restore" onClick={() => void doRestore()}>
                  确认恢复？（当前内容会先自动存档）
                </button>
                <button type="button" className="wb-hist-cancel" onClick={() => setPhase("idle")}>
                  取消
                </button>
              </>
            ) : (
              <span className="wb-hist-note">恢复中…</span>
            )}
          </div>
        </div>
      )}

      {/* 错误放面板级：加载失败时 versions 还是 null，藏在「选中某版」里根本看不见，
          界面会永远转圈 */}
      {error && sel && <div className="wb-hist-error">{error}</div>}

      {!sel && versions !== null && versions.length > 0 && (
        <div className="wb-hist-foot">选一个版本查看它与当前的差异。每个文件最多留 20 版、总计 512MB，超出自动淘汰最旧。</div>
      )}
    </div>
  );
}
