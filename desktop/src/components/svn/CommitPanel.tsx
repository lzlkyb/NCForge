import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { letterTone, type ChangeItem } from "../../lib/svn";

/**
 * 提交视图（右栏原地替换，不弹模态框）。
 *
 * 勾选状态默认「全勾掉冲突」，不是「全不勾」：审查流的动作是「把不想提的勾掉」，
 * 从 30 个文件里一个个勾上比勾掉两三个慢一个数量级。
 *
 * 状态刷新后只自动勾上**新出现**的文件（`seenRef` 记着见过的），
 * 否则用户刚取消勾选的会被一次轮询又勾回去。
 */
export function CommitPanel({
  items,
  hasConflict,
  busy,
  onSubmit,
  onCancel,
}: {
  items: ChangeItem[];
  hasConflict: boolean;
  busy: boolean;
  onSubmit: (message: string, paths: string[]) => void;
  onCancel: () => void;
}) {
  const files = useMemo(() => items.filter((it) => !it.isDir), [items]);
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const f of files) {
        // 冲突文件一律剔除：桥会直接拒绝整笔提交，留着只会让用户点了报错
        if (f.letter === "C") {
          next.delete(f.path);
          continue;
        }
        if (!seenRef.current.has(f.path)) next.add(f.path);
        seenRef.current.add(f.path);
      }
      return next;
    });
  }, [files]);

  const conflictCount = files.filter((f) => f.letter === "C").length;
  const pickedCount = files.filter((f) => picked.has(f.path)).length;
  const canSubmit = !busy && pickedCount > 0 && message.trim().length > 0;

  const toggle = (path: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    setPicked(() => {
      const all = files.filter((f) => f.letter !== "C").map((f) => f.path);
      return all.length === pickedCount ? new Set() : new Set(all);
    });
  };

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(
      message.trim(),
      files.filter((f) => picked.has(f.path)).map((f) => f.path),
    );
  };

  return (
    <section className="vc-commit">
      <div className="vc-bar">
        <Icon name="upload" size={14} />
        <b>提交</b>
        <span className="vc-sp" />
        <span className="vc-hint">
          {conflictCount > 0
            ? `将提交 ${pickedCount} 个文件（不含 ${conflictCount} 个冲突）`
            : `将提交 ${pickedCount} / ${files.length} 个文件`}
        </span>
      </div>

      <div className="vc-commit-body">
        <div className="vc-label">
          提交说明
          <span className="vc-sp" />
          <span className="vc-hint">第一行会显示在历史列表里</span>
        </div>
        <textarea
          className="vc-msg"
          autoFocus
          value={message}
          placeholder={"一句话说清改了什么，例如：\n视光品种（CL04）：工单保存时型号自动转大写"}
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />

        {hasConflict && (
          <div className="vc-alert" data-tone="bad">
            <Icon name="alert" size={13} />
            <span>
              <b>{conflictCount} 个文件有冲突</b>，已从提交清单里剔除。冲突没解决前提交会被 SVN 服务端拒绝。
            </span>
          </div>
        )}

        <div className="vc-pick">
          <div className="vc-pick-hd">
            <button
              type="button"
              className="vc-cbx"
              data-on={pickedCount > 0 && pickedCount === files.length - conflictCount ? true : undefined}
              onClick={toggleAll}
              title={pickedCount > 0 ? "全不选" : "全选"}
              aria-label="全选"
            >
              <Icon name="check" size={9} />
            </button>
            已勾选 {pickedCount} / {files.length - conflictCount}
            <span className="vc-sp" />
            <button type="button" className="vc-btn vc-btn-sm" onClick={toggleAll}>
              {pickedCount > 0 ? "全不选" : "全选"}
            </button>
          </div>
          {files.map((f) => {
            const off = f.letter === "C" || !picked.has(f.path);
            return (
              <button
                key={f.path}
                type="button"
                className="vc-pick-it"
                data-off={off || undefined}
                disabled={f.letter === "C"}
                onClick={() => toggle(f.path)}
                title={f.rel}
              >
                <span className="vc-cbx" data-on={!off || undefined}>
                  <Icon name="check" size={9} />
                </span>
                <span className="vc-badge" data-st={letterTone(f.letter)}>
                  {f.letter}
                </span>
                <span className="vc-fn">{f.rel.slice(f.rel.lastIndexOf("/") + 1)}</span>
                <span className="vc-sp" />
                <span className="vc-hint">
                  {f.letter === "C" ? "冲突，不可提交" : f.letter === "?" ? "提交时自动 add" : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="vc-commit-foot">
        <button type="button" className="vc-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <span className="vc-sp" />
        <span className="vc-hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 提交
        </span>
        <button type="button" className="vc-btn vc-btn-primary" disabled={!canSubmit} onClick={submit}>
          {busy ? <Icon name="spinner" size={12} /> : <Icon name="check" size={12} />}
          {busy ? "提交中…" : `提交 ${pickedCount} 个文件`}
        </button>
      </div>
    </section>
  );
}
