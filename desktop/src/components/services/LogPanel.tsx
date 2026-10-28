import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { serverClearLog } from "../../lib/server";
import { countLevels, filterLines, formatBytes, type LogLine } from "../../lib/serverLog";
import { useServerLog } from "../../hooks/useServerLog";

/** 一次最多渲染多少行。日志保留 4000 行，DOM 只挂最后这些—— */
/** 每 500ms 追加时若 diff 4000 个节点，界面会明显掉帧，而用户只看最新几百行。 */
const MAX_RENDER = 500;

type LevelFilter = "all" | "warn" | "error";

interface Props {
  /** 运行中/启动中才轮询；停止后只拉一次收尾。 */
  active: boolean;
  /** 每次启动 +1：换一代日志（后端启动时已把旧日志轮转掉）。 */
  generation: number;
  logPath: string;
  logSize: number;
  onReveal: () => void;
  onCleared: () => void;
}

/**
 * 日志面板：增量轮询 + 级别/关键字过滤 + 跟随 + 复制/清空。
 *
 * 为什么轮询而不是订阅事件：日志是「按 offset 拉增量」，重复拉同一段不会出错，
 * 漏一拍只是晚 0.5 秒；事件方式丢一条就永久缺行，而排查问题时少的偏偏是那条。
 */
export function LogPanel({ active, generation, logPath, logSize, onReveal, onCleared }: Props) {
  const { lines, error, reset } = useServerLog(active, generation);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);

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
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
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
      await serverClearLog();
      reset();
      onCleared();
    } catch (e) {
      toast(`清空日志失败：${e}`, "error");
    }
  };

  return (
    <section className="sv-log">
      <div className="sv-log-bar">
        <div className="sv-lv">
          <button type="button" data-on={level === "all" || undefined} onClick={() => setLevel("all")}>
            全部<span className="sv-n">{counts.all}</span>
          </button>
          <button type="button" data-on={level === "warn" || undefined} onClick={() => setLevel("warn")}>
            警告<span className="sv-n">{counts.warn}</span>
          </button>
          <button type="button" data-on={level === "error" || undefined} onClick={() => setLevel("error")}>
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
            onChange={(e) => setKeyword(e.target.value)}
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
            setFollow((f) => {
              if (!f) {
                const el = bodyRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }
              return !f;
            });
          }}
        >
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          className="sv-icon-btn"
          data-on={wrap || undefined}
          title={wrap ? "自动换行：开" : "自动换行：关"}
          onClick={() => setWrap((w) => !w)}
        >
          <Icon name="log" size={14} />
        </button>
        <button type="button" className="sv-icon-btn" title="复制当前显示的行" onClick={() => void onCopy()}>
          <Icon name="copy" size={14} />
        </button>
        <button
          type="button"
          className="sv-icon-btn"
          title="清空日志（旧的存为 middleware.log.1）"
          onClick={() => void onClear()}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div ref={bodyRef} className="sv-log-body" data-wrap={wrap || undefined}>
        {error && <div className="sv-log-empty">读日志失败：{error}</div>}
        {!error && shown.length === 0 && (
          <div className="sv-log-empty">
            {lines.length === 0 ? "暂无输出。点「启动」后这里会跟随中间件的控制台输出。" : "没有匹配的行。"}
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
        <span>
          {counts.all} 行{logSize > 0 ? ` · ${formatBytes(logSize)}` : ""}
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
