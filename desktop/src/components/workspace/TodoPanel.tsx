// 底部面板的「待办」标签：工作区里的 TODO / FIXME / XXX / HACK。
//
// 首次进来不自动扫（newar 七千个文件，点了这个标签就卡几秒很突兀），
// 只显示缓存；没有缓存就给一个「扫描」按钮。之后的结果按工作区缓存。
import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { cachedTodos, scanTodos, type TodoItem } from "../../lib/todoScan";
import { toast } from "../ui/toast";

/** 列表上限：面板是拿来扫一眼的，不是全量报表（缓存里仍有全部，滚动即可）。 */
const SHOW_MAX = 500;

export function TodoPanel({
  root,
  onOpenAt,
}: {
  root: string;
  onOpenAt: (path: string, line: number) => void;
}) {
  const [items, setItems] = useState<TodoItem[]>(() => cachedTodos(root)?.items ?? []);
  const [truncated, setTruncated] = useState(() => cachedTodos(root)?.truncated ?? false);
  const [busy, setBusy] = useState(false);

  // 换工作区：缓存是按 root 存的，切过来要重新取（没缓存就是空列表 + 扫描按钮）
  useEffect(() => {
    const c = cachedTodos(root);
    setItems(c?.items ?? []);
    setTruncated(c?.truncated ?? false);
  }, [root]);

  const run = async (force: boolean) => {
    setBusy(true);
    try {
      const r = await scanTodos(root, force);
      setItems(r.items);
      setTruncated(r.truncated);
      if (r.items.length === 0) toast("没有找到待办标记", "info");
    } catch (e) {
      toast(`扫描失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const shown = items.slice(0, SHOW_MAX);

  return (
    <div className="wb-panel-body">
      <div className="wb-panel-note">
        待办标记（TODO / FIXME / XXX / HACK）· {items.length} 条
        <button type="button" className="wb-status-btn" disabled={busy} onClick={() => void run(true)}>
          {busy ? "扫描中…" : "重新扫描"}
        </button>
      </div>
      {items.length === 0 && !busy && (
        <div className="wb-panel-note">
          <button type="button" className="wb-status-btn" onClick={() => void run(false)}>
            开始扫描工作区
          </button>
        </div>
      )}
      {truncated && <div className="wb-panel-note">结果太多，搜索已截断（只显示前 2000 条命中）</div>}
      {shown.map((t) => (
        <button
          type="button"
          key={`${t.path}#${t.line}`}
          className="wb-prow"
          title={`${t.path}:${t.line}`}
          onClick={() => onOpenAt(`${root}\\${t.path.replace(/\//g, "\\")}`, t.line)}
        >
          <Icon name="check" size={14} className="wb-prow-info" />
          <span className="wb-prow-msg">
            <span className="wb-prow-warn">{t.tag}</span> {t.text}
          </span>
          <span className="wb-prow-loc">
            {baseName(t.path)}:{t.line}
          </span>
        </button>
      ))}
      {items.length > SHOW_MAX && (
        <div className="wb-panel-note">下面还有 {items.length - SHOW_MAX} 条未显示（用全工程搜索缩小范围）</div>
      )}
    </div>
  );
}
