import { useOperations } from "../../lib/operations";
import { Icon } from "../ui/icon";
import { inLangModule, restartLang, startLangNow, useLangView } from "../../lib/lang";
import { Menu, MenuItem } from "../ui/Menu";
import { setLightMode } from "../../lib/lightMode";
import { toast } from "../ui/toast";
import { missingResourceId } from "../../lib/resourceMissing";
import { requestResourceDownload } from "../../lib/resourceActions";

/**
 * 状态栏里的代码智能状态（视觉取自设计稿的 `.ls`：绿点就绪、黄点脉冲忙磌）。
 *
 * 「就绪」后的前 12 秒仍算忙：jdt.ls 还在补算索引，此时的报错不可信，所以不显示。
 */
export function LangBadge({ activePath }: { activePath: string | null }) {
  const v = useLangView();
  const requesting = useOperations().some(o => o.key === "language.control" && (o.state === "running" || o.state === "cancelling"));
  // 总开关关掉时不能什么都不显示：用户会以为「跳转/补全坏了」而找不到原因。
  // 做成可点的按钮：状态栏是用户最常看到它的地方，恢复代码智能不该再绕去设置页。
  if (!v.enabled) {
    return (
      <button
        type="button"
        className="wb-status-btn wb-lang"
        data-tone="off"
        title="当前是轻量模式：jdt.ls 与语义着色已暂停，有语法高亮、搜索、编译，没有跳转与补全。点击恢复代码智能"
        onClick={() => {
          void setLightMode(false, activePath).then(
            (r) => toast(r.ok ? "已恢复代码智能" : (r.error ?? "恢复失败"), r.ok ? "success" : "error"),
          );
        }}
      >
        <span className="wb-lang-dot" />
        <span className="wb-lang-text">轻量模式 · 恢复代码智能</span>
      </button>
    );
  }
  if (v.state === "stopped") {
    // 自动启动关掉时要有个手动入口
    if (v.autoStart || !activePath?.toLowerCase().endsWith(".java")) return null;
    return (
      <button
        type="button"
        className="wb-status-btn wb-lang"
        title="自动启动已在设置里关闭：点击为当前模块启动代码智能（约 650MB 内存）"
        disabled={requesting}
        aria-busy={requesting}
        onClick={() => startLangNow(activePath)}
      >
        {requesting && <Icon name="spinner" size={11} className="animate-spin" />}
        <span className="wb-lang-text">{requesting ? "正在启动代码智能" : "启动代码智能"}</span>
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
    const missing = missingResourceId(v.message) === "jdtls";
    return (
      <button
        type="button"
        className="wb-status-btn wb-lang"
        data-tone="bad"
        title={`${v.message}\n\n${missing ? "点击下载代码智能组件，完成后可重试启动" : "点击重试"}`}
        disabled={requesting}
        aria-busy={requesting}
        onClick={() => missing ? requestResourceDownload("jdtls") : activePath && void restartLang(activePath).catch(e => toast(`重启代码智能失败：${e}`, "error"))}
      >
        {requesting && <Icon name="spinner" size={11} className="animate-spin" />}
        <span className="wb-lang-text">{requesting ? "正在重启代码智能" : missing ? "代码智能缺少组件 · 下载" : "代码智能不可用 · 重试"}</span>
      </button>
    );
  }
  const text =
    v.state === "starting"
      ? "代码智能：准备中…"
      : v.state === "indexing"
        ? "代码智能：正在建立索引…"
        : v.settled
          ? "jdt.ls 就绪"
          : "代码智能：就绪，错误提示稍后显示…";
  return (
    <Menu portal align="left" width="w-72" trigger={(open, toggle) => <button type="button" className="wb-status-btn wb-lang" aria-label="代码智能状态详情" aria-haspopup="menu" aria-expanded={open} data-tone={v.state === "ready" && v.settled ? "ok" : "busy"} title={detail} onClick={toggle}>
      <span className="wb-lang-dot" /><span className="wb-lang-text">{text}</span>
    </button>}>
      {close => <>
        <p className="wb-tree-menu-note">{text}</p>
        <p className="wb-tree-menu-note">{v.module ? `当前模块：${v.module}` : "尚未建立模块上下文"}</p>
        <p className="wb-tree-menu-note">{activePath && inLangModule(activePath) ? "当前文件在代码智能范围内" : "当前文件不在已启动模块范围内；打开 Java 文件后可建立对应模块索引。"}</p>
        {v.message && <p className="wb-tree-menu-note">{v.message}</p>}
        <MenuItem label="为当前文件重新建立索引" icon="refresh" disabled={requesting || v.state !== "ready" || !activePath?.toLowerCase().endsWith(".java")}
          onClick={() => { close(); if (activePath) void restartLang(activePath).catch(e => toast(`重新建立索引失败：${String(e)}`, "error")); }} />
      </>}
    </Menu>
  );
}
