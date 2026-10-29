import { useCallback, useEffect, useMemo, useRef } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { serverClearLog } from "../../lib/server";
import { countLevels, filterLines, formatBytes, type LogLine } from "../../lib/serverLog";
import { useServerLog } from "../../hooks/useServerLog";
import { logPanelStore, useLogPanelForm } from "../../lib/logPanelStore";

/** 一次最多渲染多少行。日志保留 4000 行，DOM 只挂最后这些—— */
/** 每 500ms 追加时若 diff 4000 个节点，界面会明显掉帧，而用户只看最新几百行。 */
const MAX_RENDER = 500;

interface Props {
  /** 运行中/启动中才轮询；停止后只拉一次收尾。 */
  active: boolean;
  /** 每次启动 +1：换一代日志（后端启动时已把旧日志轮转掉）。 */
  generation: number;
  logPath: string;
  logSize: number;
  /** 窗口隐藏：停掉日志轮询（本页约定「隐藏即停」）。 */
  appHidden: boolean;
  onReveal: () => void;
  onCleared: () => void;
}

/**
 * 日志面板：增量轮询 + 级别/关键字过滤 + 跟随 + 复制/清空。
 *
 * 为什么轮询而不是订阅事件：日志是「按 offset 拉增量」，重复拉同一段不会出错，
 * 漏一拍只是晚 0.5 秒；事件方式丢一条就永久缺行，而排查问题时少的偏偏是那条。
 */
export function LogPanel({ active, generation, logPath, logSize, appHidden, onReveal, onCleared }: Props) {
  const { lines, error, reset } = useServerLog(active, generation, appHidden);
  // P2-9：级别/关键字过滤与跟随/换行进模块级仓库——「服务页看日志 → 文件页
  // 改代码 → 回来看新日志」是排查动线，过滤器不能随切页重置。
  const { level, keyword, follow, wrap } = useLogPanelForm();

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 跟随最新：只在用户没往上翻时贴底
  useEffect(() => {
    const el = bodyRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  // Ctrl+F 聚焦过滤框（服务页独占，不影响其他页）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.key.toLowerCase() !== "f") return;
      // 有弹窗打开时不抢：焦点会被从遮罩后面拽进过滤框，和弹窗的焦点陷阱互相拉扯，
      // 用户看到的是一按 Ctrl+F 弹窗就"卡住"了（其实焦点跑到看不见的输入框里）。
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-exiting])')) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(() => countLevels(lines), [lines]);
  const filtered = useMemo(() => filterLines(lines, level, keyword), [lines, level, keyword]);
  const shown = filtered.length > MAX_RENDER ? filtered.slice(filtered.length - MAX_RENDER) : filtered;
  const omitted = filtered.length - shown.length;

  const onCopy = useCallback(async () => {
    if (!shown.length) return;
    try {
      await navigator.clipboard.writeText(shown.map(toRaw).join("\n"));
      toast(`已复制 ${shown.length} 行日志`, "success");
    } catch (e) {
      toast(`复制失败：${e}`, "error");
    }
  }, [shown]);

  const onClear = async () => {
    try {
      const result = await serverClearLog();
      // 运行中清空只是「从现在开始看」：文件没动，偏移要快进到末尾，
      // 否则归零后旧内容会被整份读回来。
      reset(result.offset);
      if (!result.rotated) {
        toast("运行中：已清屏，磁盘上的日志文件未删除", "info");
      }
      onCleared();
    } catch (e) {
      toast(`清空日志失败：${e}`, "error");
    }
  };

  return (
    <section className="sv-log">
      <div className="sv-log-bar">
        <div className="sv-lv">
          <button type="button" data-on={level === "all" || undefined} onClick={() => logPanelStore.set({ level: "all" })}>
            全部<span className="sv-n">{counts.all}</span>
          </button>
          <button type="button" data-on={level === "warn" || undefined} onClick={() => logPanelStore.set({ level: "warn" })}>
            警告<span className="sv-n">{counts.warn}</span>
          </button>
          <button type="button" data-on={level === "error" || undefined} onClick={() => logPanelStore.set({ level: "error" })}>
            错误<span className="sv-n">{counts.error}</span>
          </button>
        </div>
        <span className="sv-divider" />
        <label className="sv-search">
          <Icon name="search" size={12} />
          <input
            ref={inputRef}
            value={keyword}
            placeholder="过滤日志…"
            onChange={(e) => logPanelStore.set({ keyword: e.target.value })}
          />
          <span className="sv-kbd">Ctrl F</span>
        </label>
        <span className="sv-sp" />
        <button
          type="button"
          className="sv-icon-btn"
          data-on={follow || undefined}
          title={follow ? "正在跟随最新（点一下暂停）" : "已暂停跟随（点一下回到底部）"}
          onClick={() => {
            // 恢复跟随时立即贴底（原 setFollow updater 里的副作用，语义不变）
            if (!follow) {
              const el = bodyRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }
            logPanelStore.set({ follow: !follow });
          }}
        >
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          className="sv-icon-btn"
          data-on={wrap || undefined}
          title={wrap ? "自动换行：开" : "自动换行：关"}
          onClick={() => logPanelStore.set({ wrap: !wrap })}
        >
          <Icon name="log" size={14} />
        </button>
        <button type="button" className="sv-icon-btn" title="复制当前显示的行" onClick={() => void onCopy()}>
          <Icon name="copy" size={14} />
        </button>
        <button
          type="button"
          className="sv-icon-btn"
          title={
            active
              ? "清空当前显示（服务运行中：磁盘文件不动，只是从现在开始看；旧内容还在日志文件里）"
              : "清空日志（旧的存为 middleware.log.1）"
          }
          onClick={() => void onClear()}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div ref={bodyRef} className="sv-log-body" data-wrap={wrap || undefined}>
        {error && <div className="sv-log-empty">读日志失败：{error}</div>}
        {!error && shown.length === 0 && (
          <div className="sv-log-empty">
            {lines.length === 0 ? "还没有输出。点「启动」后这里会跟随中间件的控制台输出。" : "没有匹配的行。"}
          </div>
        )}
        {omitted > 0 && <div className="sv-log-more">前 {omitted} 行未渲染（只显示最新 {MAX_RENDER} 行）</div>}
        {shown.map((line) => (
          <div key={line.id} className="sv-ln" data-lv={line.level} data-stack={line.stack || undefined}>
            <span className="sv-ts">{line.time}</span>
            <span className="sv-th">{line.stack ? "" : line.thread}</span>
            <span className="sv-lvl">{line.stack ? "" : line.level.toUpperCase()}</span>
            {line.logger && (
              <span className="sv-obj" title={line.logger}>
                {line.logger}
              </span>
            )}
            <span className="sv-msg">{line.text}</span>
          </div>
        ))}
      </div>

      <div className="sv-log-foot">
        {/* 这里必须是「已加载」而不是「N 行」：面板只在内存里留最近 4000 行，
            而右边是磁盘文件的真实大小。写成「4000 行 · 312.4 MB」会让用户以为
            整个日志只有 4000 行，从而漏掉更早的关键报错。 */}
        <span title="面板只加载最近 4000 行（内存保留上限）；完整内容在日志文件里，点「日志位置」打开">
          {counts.all} 行已加载{logSize > 0 ? ` · 日志文件 ${formatBytes(logSize)}` : ""}
        </span>
        <span>·</span>
        <button type="button" className="sv-link" onClick={onReveal} title={logPath}>
          日志位置
        </button>
        <span className="sv-sp" />
        <span className="sv-follow">
          <span className="sv-follow-dot" data-off={!follow || undefined} />
          {active ? (follow ? "跟随中 · 每 0.5 秒刷新" : "已暂停跟随") : "未在运行，不再刷新"}
        </span>
      </div>
    </section>
  );
}

/** 把结构化行还原成可粘贴的原文（复制给人贴到聊天里排查用）。 */
function toRaw(l: LogLine): string {
  if (l.stack) return l.text;
  const parts: string[] = [];
  if (l.time) parts.push(l.time);
  if (l.thread) parts.push(`[${l.thread}]`);
  parts.push(l.level.toUpperCase());
  if (l.logger) parts.push(l.logger, "-");
  parts.push(l.text);
  return parts.join(" ");
}
