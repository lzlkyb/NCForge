import { describeFastIndex, useFastIndexStatus } from "../../lib/fastIndex";

/**
 * 「声明索引」一行：快通道的规模、体积与构建结果。
 *
 * 它是**诊断信息**，不是主功能：读取中或拿不到状态就整行不出现，不占位、不弹错。
 * 失败态用 `role="status"` 而不是 `role="alert"` —— 索引挂了跳转仍可用（退回内容搜索），
 * 不值得打断用户。
 */
export function DeclIndexStatusLine() {
  const st = useFastIndexStatus();
  if (!st) return null;
  const failed = st.state === "failed";
  return (
    <p
      className={failed ? "text-xs text-destructive-ink" : "text-xs text-muted-foreground"}
      role="status"
      data-tone={failed ? "error" : "muted"}
      title={failed ? st.error ?? undefined : undefined}
    >
      {describeFastIndex(st)}
    </p>
  );
}
