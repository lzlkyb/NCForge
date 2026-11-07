/**
 * 失败提示的统一出口：中文人话 + 可复制的英文原文。
 *
 * 为什么要有这个函数而不是各处写 `toast(failureText(...), "error")`：
 * `failureText` 只产出给人看的中文，翻译命中规则时原文就被丢掉了，用户在
 * 「复制全部错误」里贴给同事的内容不含 Rust 的原始报错，排查只能靠猜。
 * 这里把原文一起带进 toast 的 `raw` 字段（默认视图不显示，只参与复制）。
 *
 * `e` 上如果已经带了 `raw`（例如 Tauri 命令包装过一层），优先用那个。
 */
import { errorTextOf, failureText, type ErrorDomain } from "./friendlyError";
import { toast } from "../components/ui/toast";

export function errorToast(action: string, e: unknown, domain: ErrorDomain = "general"): void {
  const carried = (e as { raw?: unknown } | null)?.raw;
  const raw = typeof carried === "string" && carried.trim() ? carried : errorTextOf(e) || String(e);
  toast(failureText(action, e, domain), "error", { raw });
}
