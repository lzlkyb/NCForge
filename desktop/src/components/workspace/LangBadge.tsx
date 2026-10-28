import { restartLang, useLangView } from "../../lib/lang";

/**
 * 状态栏里的代码智能状态（视觉取自设计稿的 `.ls`：绿点就绪、黄点脉冲忙磌）。
 *
 * 「就绪」后的前 12 秒仍算忙：jdt.ls 还在补算索引，此时的报错不可信，所以不显示。
 */
export function LangBadge({ activePath }: { activePath: string | null }) {
  const v = useLangView();
  if (v.state === "stopped") return null;
  const detail = [
    v.module ? `模块 ${v.module}` : "",
    v.sourceFiles ? `${v.sourceFiles} 个源文件、${v.jarCount} 个 jar` : "",
    v.message,
  ]
    .filter(Boolean)
    .join(" · ");

  if (v.state === "error") {
    return (
      <button
        type="button"
        className="wb-status-btn wb-lang"
        data-tone="bad"
        title={`${v.message}\n\n点击重试`}
        onClick={() => activePath && void restartLang(activePath)}
      >
        代码智能不可用 · 重试
      </button>
    );
  }
  const text =
    v.state === "starting"
      ? "代码智能：准备中…"
      : v.state === "indexing"
        ? "代码智能：正在建立索引（首次约 40 秒）…"
        : v.settled
          ? "jdt.ls 就绪"
          : "代码智能：就绪，错误提示稍后显示…";
  return (
    <span className="wb-lang" data-tone={v.state === "ready" && v.settled ? "ok" : "busy"} title={detail}>
      <span className="wb-lang-dot" />
      {text}
    </span>
  );
}
