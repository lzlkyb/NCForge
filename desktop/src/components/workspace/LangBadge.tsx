import { restartLang, startLangNow, useLangView } from "../../lib/lang";

/**
 * 状态栏里的代码智能状态（视觉取自设计稿的 `.ls`：绿点就绪、黄点脉冲忙磌）。
 *
 * 「就绪」后的前 12 秒仍算忙：jdt.ls 还在补算索引，此时的报错不可信，所以不显示。
 */
export function LangBadge({ activePath }: { activePath: string | null }) {
  const v = useLangView();
  // 总开关关掉时不能什么都不显示：用户会以为「跳转/补全坏了」而找不到原因。
  // 显式标成轻量模式并说明去哪儿打开（这里不做成按钮——本组件拿不到导航能力，
  // 放个点不动的入口比没有入口更糟）。
  if (!v.enabled) {
    return (
      <span
        className="wb-lang"
        data-tone="off"
        title="代码智能已在设置里关闭，当前是轻量模式：有语法高亮、搜索、编译，没有跳转与补全。可在「设置 → 代码智能」重新打开"
      >
        <span className="wb-lang-dot" />
        轻量模式
      </span>
    );
  }
  if (v.state === "stopped") {
    // 自动启动关掉时要有个手动入口
    if (v.autoStart || !activePath?.toLowerCase().endsWith(".java")) return null;
    return (
      <button
        type="button"
        className="wb-status-btn"
        title="自动启动已在设置里关闭：点击为当前模块启动代码智能（约 650MB 内存）"
        onClick={() => startLangNow(activePath)}
      >
        启动代码智能
      </button>
    );
  }
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
