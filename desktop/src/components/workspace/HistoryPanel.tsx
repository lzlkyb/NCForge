// 本地版本嵌入底部改动面板；浮层模式保留独立关闭行为。
// 比较可使用当前编辑模型，但恢复始终使用磁盘 mtime，并禁止覆盖未保存修改。
// 版本与滚动按文件记忆；详情随所选版本重挂，避免旧版确认状态泄漏到新版。
import { useEffect, useRef, useState } from "react";
import { focusReadingTrigger } from "../../lib/readingFocus";
import { Icon } from "../ui/icon";
import { readFile, type FileContent } from "../../lib/workspace";
import { formatBytes } from "../../lib/utils";
import { listLocalHistory, type HistoryVersion } from "../../lib/localHistory";
import { formatHistoryTime } from "../../lib/historyFormat";
import { HistoryDetail } from "./HistoryDetail";
import { useHistoryRestorePath, isHistoryRestoring } from "../../lib/historyRestoreGuard";

interface Props {
  embedded?: boolean;
  mtimeMs?: number;
  open: boolean;
  onClose: () => void;
  path: string | null;
  /** 文件有未保存修改：禁用恢复（先保存或还原） */
  dirty: boolean;
  /** 恢复成功后调用（父组件重载文件） */
  onRestored: (path: string) => Promise<void> | void;
}

const positions = new Map<string, { selected: string | null; scroll: number }>();

export function HistoryPanel({ open, onClose, path, dirty, onRestored, embedded = false, mtimeMs }: Props) {
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [current, setCurrent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  /** 恢复写盘中：列表切换与关闭都要锁住 */
  const [localBusy, setBusy] = useState(false);
  useHistoryRestorePath();
  const busy = localBusy || !!path && isHistoryRestoring(path);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(sel); selectedRef.current = sel;

  // busy / onClose 的活引用：Esc 与外点监听只在开屏时注册一次（不新增 effect），
  // 用 ref 穿透闭包读最新值
  const live = useRef({ busy, onClose });
  live.current = { busy, onClose };

  // 打开、保存或主动刷新时重读磁盘快照，恢复不能借用未保存编辑模型的时间戳。
  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    setVersions(null);
    setSel(embedded ? positions.get(path)?.selected ?? null : null);
    setCurrent(null);
    setError(null);
    void Promise.all([listLocalHistory(path), readFile(path)])
      .then(([vs, fc]) => {
        if (!alive) return;
        setVersions(vs);
        setCurrent(fc);
        if (embedded) setSel(previous => vs.some(v => v.id === previous) ? previous : vs[0]?.id ?? null);
      })
      .catch((e) => alive && setError(String(e)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      // 恢复写盘中不关：关了用户就不知道结果了
      if (!live.current.busy) { live.current.onClose(); focusReadingTrigger(panelRef.current, "history"); }
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
    if (!embedded) {
      window.addEventListener("keydown", onKey);
      document.addEventListener("pointerdown", onPointerDown);
    }
    return () => {
      if (embedded) positions.set(path, { selected: selectedRef.current, scroll: listRef.current?.scrollTop ?? positions.get(path)?.scroll ?? 0 });
      alive = false;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, path, embedded, mtimeMs, revision]);

  if (!open || !path) return null;

  return (
    <div ref={panelRef} className="wb-hist" data-embedded={embedded || undefined} role={embedded ? "region" : "dialog"} aria-label="本地历史">
    <div className="wb-hist-head">
        <Icon name="clock" size={13} />
        <span>本地历史</span>
        <span className="wb-hist-count">{versions ? `${versions.length} 版` : ""}</span>
        {embedded && <button type="button" className="wb-hist-x" aria-label="刷新本地版本" title="重新读取版本列表和磁盘基准" disabled={busy} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" size={12} /></button>}
        {!embedded && <button
          type="button"
          className="wb-hist-x"
          title={busy ? "恢复进行中，不能关闭" : "关闭"}
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>}
      </div>

      <div className="wb-hist-list" ref={node => { listRef.current = node; if (node && embedded && versions) node.scrollTop = positions.get(path)?.scroll ?? 0; }} onScroll={event => { if (embedded) positions.set(path, { selected: selectedRef.current, scroll: event.currentTarget.scrollTop }); }}>
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
              if (embedded) positions.set(path, { selected: v.id, scroll: listRef.current?.scrollTop ?? 0 });
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
          key={`${path}:${sel}`}
          path={path}
          versionId={sel}
          current={current}
          dirty={dirty}
          embedded={embedded}
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
