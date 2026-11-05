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
//
// 选中版本的详情（diff / 恢复）在 HistoryDetail 里：它按选中版本重挂，
// 预览与恢复进度只属于那一版。这里只管列表、磁盘快照与「恢复中不许关」。
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { readFile, type FileContent } from "../../lib/workspace";
import { formatBytes } from "../../lib/utils";
import { listLocalHistory, type HistoryVersion } from "../../lib/localHistory";
import { formatHistoryTime } from "../../lib/historyFormat";
import { HistoryDetail } from "./HistoryDetail";

interface Props {
  open: boolean;
  onClose: () => void;
  path: string | null;
  /** 文件有未保存修改：禁用恢复（先保存或还原） */
  dirty: boolean;
  /** 恢复成功后调用（父组件重载文件） */
  onRestored: (path: string) => void;
}

export function HistoryPanel({ open, onClose, path, dirty, onRestored }: Props) {
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [current, setCurrent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 恢复写盘中：列表切换与关闭都要锁住 */
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // busy / onClose 的活引用：Esc 与外点监听只在开屏时注册一次（不新增 effect），
  // 用 ref 穿透闭包读最新值
  const live = useRef({ busy, onClose });
  live.current = { busy, onClose };

  // 打开时：版本列表 + 磁盘现状（diff 的右侧、恢复的 mtime 基准）
  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    setVersions(null);
    setSel(null);
    setCurrent(null);
    setError(null);
    setBusy(false);
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
      if (!live.current.busy) live.current.onClose();
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
      if (!live.current.busy) live.current.onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, path]);

  if (!open || !path) return null;

  return (
    <div ref={panelRef} className="wb-hist" role="dialog" aria-label="本地历史">
    <div className="wb-hist-head">
        <Icon name="clock" size={13} />
        <span>本地历史</span>
        <span className="wb-hist-count">{versions ? `${versions.length} 版` : ""}</span>
        <button
          type="button"
          className="wb-hist-x"
          title={busy ? "恢复进行中，不能关闭" : "关闭"}
          aria-label="关闭"
          disabled={busy}
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
            disabled={busy}
            data-active={v.id === sel || undefined}
            onClick={() => {
              if (busy) return;
              setSel(v.id);
              setError(null);
            }}
          >
            <span className="wb-hist-time" title={formatHistoryTime(v.ts).title}>
              {formatHistoryTime(v.ts).label}
            </span>
            <span className="wb-hist-size">{formatBytes(v.size)}</span>
          </button>
        ))}
      </div>

      {/* key：换版本直接重挂，预览 / 恢复进度 / diff 展开量都跟着重置 */}
      {sel && current && (
        <HistoryDetail
          key={sel}
          path={path}
          versionId={sel}
          current={current}
          dirty={dirty}
          onBusyChange={setBusy}
          onFileChanged={() => onRestored(path)}
          onRestored={(vs, fc) => {
            setVersions(vs);
            setCurrent(fc);
            setSel(null);
            setBusy(false);
          }}
        />
      )}

      {!sel && versions !== null && versions.length > 0 && (
        <div className="wb-hist-foot">选一个版本查看它与当前的差异。每个文件最多留 20 版、总计 512MB，超出自动淘汰最旧。</div>
      )}
    </div>
  );
}
