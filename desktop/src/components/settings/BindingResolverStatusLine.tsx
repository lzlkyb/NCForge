import { describeBinding, useBindingStatus } from "../../lib/bindingResolver";

/**
 * 「精确解析」一行：常驻 resolver 的运行态。
 *
 * 与 `DeclIndexStatusLine` 同款定位：**诊断信息**，读取中或拿不到状态就整行不出现。
 * 失败态用 `role="status"` 而不是 `role="alert"`——答不上时跳转仍可用
 * （退回内容搜索），不值得打断用户。
 *
 * 「有没有错」看 `error` 而不是只看 `backoff`：退避是运行中连续失败，
 * 环境装不起来（缺桥 jar / 缺 JDK）停在 `idle` 但也带 error——不报出来就是
 * 静默降级，用户只会觉得精确跳转时好时坏。
 */
export function BindingResolverStatusLine() {
  const st = useBindingStatus();
  if (!st) return null;
  const failed = !!st.error;
  return (
    <p
      className={failed ? "text-xs text-destructive-ink" : "text-xs text-muted-foreground"}
      role="status"
      data-tone={failed ? "error" : "muted"}
      title={st.error ?? undefined}
    >
      {describeBinding(st)}
    </p>
  );
}
