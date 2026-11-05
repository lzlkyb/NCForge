// 暂停原因条：为什么停在这里。
//
// 普通断点只说「命中断点」；异常停靠要把类型、消息、栈带出来——这是排查 NC 线上
// 异常最需要的一屏。复制按钮给出一份能直接贴进缺陷单的文本。
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import type { DebugException } from "../../lib/debugSession";

const REASON_LABEL: Record<string, string> = {
  breakpoint: "命中断点",
  step: "单步完成",
  pause: "手动暂停",
  exception: "异常停靠",
  entry: "程序入口",
  "data breakpoint": "数据断点",
};

export function stopSummary(reason: string | null, exception: DebugException | null, text: string | null): string {
  const parts: string[] = [];
  const label = reason ? REASON_LABEL[reason] ?? reason : "已暂停";
  parts.push(label);
  if (exception?.id) parts.push(exception.id);
  if (exception?.message) parts.push(exception.message);
  if (exception?.description && exception.description !== text) parts.push(exception.description);
  if (text && !exception?.description) parts.push(text);
  return parts.join("\n");
}

export function DebugStopBanner({
  reason,
  text,
  exception,
}: {
  reason: string | null;
  text: string | null;
  exception: DebugException | null;
}) {
  const label = reason ? REASON_LABEL[reason] ?? reason : "已暂停";
  const summary = stopSummary(reason, exception, text);
  const isException = reason === "exception" || exception !== null;

  return (
    <div className="dbg-stop" data-exc={isException || undefined}>
      <span className="dbg-stop-tag">
        {isException ? <Icon name="alertTriangle" size={12} /> : <Icon name="pause" size={11} />}
        {label}
      </span>
      <div className="dbg-stop-body">
        {exception?.id && <span className="dbg-stop-id">{exception.id}</span>}
        {exception?.message && <span className="dbg-stop-msg">{exception.message}</span>}
        {!exception?.message && text && <span className="dbg-stop-msg">{text}</span>}
        {exception?.description && (
          <pre className="dbg-stop-stack" title={exception.description}>
            {exception.description}
          </pre>
        )}
      </div>
      <button
        type="button"
        className="dbg-icon-btn dbg-stop-copy"
        title="复制暂停原因"
        onClick={() => void copyText(summary, () => toast("已复制暂停原因", "success"))}
      >
        <Icon name="copy" size={11} />
      </button>
    </div>
  );
}
