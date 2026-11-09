import { useState, useCallback, useEffect, useRef, createContext, useContext, type ReactNode } from "react";
import { Icon, type IconName } from "./icon";
import { usePresence } from "../../hooks/usePresence";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useAppHidden } from "../../lib/appVisibility";

type ToastVariant = "success" | "error" | "warning" | "info";

/** 附加信息：英文原文等可复制的调试细节，默认视图不显示，「复制全部错误」时附上。 */
interface ToastOptions {
  raw?: string;
  /** 一次性操作入口（如关闭标签后的「撤销」）；有它时通知停留更久，也不点空白即关。 */
  action?: { label: string; onClick: () => void };
  /** 归属标识：发起方之后可以用 `toast.dismiss(key)` 收回（如服务重启后「热替换失败」已过时）。 */
  key?: string;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  raw?: string;
  action?: { label: string; onClick: () => void };
  key?: string;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

/**
 * Toast 文案规范（UI 精修统一约定，调用方请遵守）：
 *  - success：操作成功类（"已复制" / "已还原到操作前版本"），用 check 图标
 *  - error：  失败/异常类（"复制失败：…" / 接口报错），用 alertTriangle 图标
 *  - warning：需提醒但非阻断（保留）
 *  - info：   中性提示（保留）
 * 约定：文案简洁、动宾结构；成功态不重复写"成功"二字（图标已表达）。
 *
 * 统一通知方案升级（design/统一通知系统设计稿.html）：
 *  - 容器从 top-16 移到右下角（远离主操作区，不遮 Header / 横幅区）；
 *  - 图标带语义底色块，底部倒计时与实际驻留同步；悬停/聚焦时暂停，关闭统一退场。
 */
export function useToast() {
  return useContext(ToastContext);
}

// 模块级单例：供非组件代码（如 lib/tauri.ts 的 invokeOrToast）直接调用 toast。
// 由 ToastProvider 挂载时写入实现；未挂载时调用为 no-op。
type ToastFn = {
  (message: string, variant?: ToastVariant, options?: ToastOptions): void;
  error: (message: string, options?: ToastOptions) => void;
  success: (message: string, options?: ToastOptions) => void;
  warning: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
  /** 收回带该 key 的通知（没有就什么都不做）。错误通知不自动消失，内容过时时由发起方收回。 */
  dismiss: (key: string) => void;
};

let toastImpl: ((message: string, variant?: ToastVariant, options?: ToastOptions) => void) | null = null;
let dismissImpl: ((key: string) => void) | null = null;

function emitToast(message: string, variant: ToastVariant = "info", options?: ToastOptions) {
  toastImpl?.(message, variant, options);
}

/**
 * 统一出口。保留 `toast(message, variant)` 老调用方式（options 可选、向后兼容），
 * 另提供 `toast.error(中文文案, { raw: String(e) })` 便捷方法，把可搜索的英文原文
 * 一并带进 toast——「复制全部错误」时会附在中文文案之后。
 */
export const toast: ToastFn = Object.assign(emitToast, {
  error: (m: string, o?: ToastOptions) => emitToast(m, "error", o),
  success: (m: string, o?: ToastOptions) => emitToast(m, "success", o),
  warning: (m: string, o?: ToastOptions) => emitToast(m, "warning", o),
  info: (m: string, o?: ToastOptions) => emitToast(m, "info", o),
  dismiss: (key: string) => dismissImpl?.(key),
}) as ToastFn;

let toastId = 0;
const TOAST_LIFETIME = 3500;
/**
 * 同屏最多几条。批量操作时每个失败都弹一条，堆到七八条会把编辑区右下角糊死；
 * 最新的几条才是用户此刻要看的。
 */
const MAX_TOASTS = 4;

// 文字用 -ink 变体：基础语义色在 12–14px 淡底上只有 2.3–3.8:1（浅色），不达 AA 4.5:1。
// info 走 primary（浅色 5.33:1）本就达标，故保持基础色。
const variantStyles: Record<ToastVariant, string> = {
  success: "border-success/30 bg-success/10 text-success-ink",
  error: "border-destructive/30 bg-destructive/10 text-destructive-ink",
  warning: "border-warning/30 bg-warning/10 text-warning-ink",
  info: "border-primary/30 bg-primary/10 text-primary",
};

const variantIcons: Record<ToastVariant, IconName> = {
  success: "check",
  error: "alertTriangle",
  warning: "alertTriangle",
  info: "activity",
};

const variantIconBoxes: Record<ToastVariant, string> = {
  success: "bg-success/[0.14] text-success-ink",
  error: "bg-destructive/[0.14] text-destructive-ink",
  warning: "bg-warning/[0.14] text-warning-ink",
  info: "bg-accent text-primary",
};

const variantProgress: Record<ToastVariant, string> = {
  success: "bg-success",
  error: "bg-destructive",
  warning: "bg-warning",
  info: "bg-primary",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const stackRef = useAutoAnimateRM<HTMLDivElement>();

  const addToast = useCallback((message: string, variant: ToastVariant = "info", options?: ToastOptions) => {
    const id = ++toastId;
    setToasts((prev) => {
      // 同一条消息只留最新一份（连点「重试」会刷出一屏一模一样的通知）；
      // 换新 id 让倒计时与进场动画重新开始，而不是静默续期
      const rest = prev.filter((t) => t.message !== message || t.variant !== variant);
      const next = [...rest, { id, message, variant, raw: options?.raw, action: options?.action, key: options?.key }];
      // 显示上限不能删除未处理错误；普通通知仅保留最近几条。
      const ordinary = next.filter(t => t.variant !== "error").slice(-MAX_TOASTS);
      return next.filter(t => t.variant === "error" || ordinary.includes(t));
    });
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissByKey = useCallback((key: string) => {
    setToasts((prev) => (prev.some((t) => t.key === key) ? prev.filter((t) => t.key !== key) : prev));
  }, []);

  // 批量失败时用户最想要的是「把这一串贴给同事/日志」，逐条复制不现实。
  const errors = toasts.filter((t) => t.variant === "error");
  // 默认视图最多 MAX_TOASTS 张卡，但**错误优先占位**：先放最近几条错误，剩余名额才给
  // 普通通知。反过来（普通通知先占满、错误被 slice 挤掉）会让「出错」这件事消失在屏幕外，
  // 只剩一个计数按钮——而错误恰恰是最需要被看见的。全部错误仍可在「查看错误」里翻。
  const ordinary = toasts.filter((t) => t.variant !== "error").slice(-MAX_TOASTS);
  const recentErrors = errors.slice(-MAX_TOASTS);
  // 注意 `slice(-0)` 等于 `slice(0)`（整段），名额为 0 时必须显式给空数组
  const room = MAX_TOASTS - recentErrors.length;
  const fill = room > 0 ? ordinary.slice(-room) : [];
  const visibleToasts = showErrors && errors.length > 0
    ? errors
    : toasts.filter((t) => recentErrors.includes(t) || fill.includes(t));
  const copyAllErrors = useCallback(() => {
    const text = errors.map((t) => t.raw ? `${t.message}\n--- raw ---\n${t.raw}` : t.message).join("\n");
    navigator.clipboard.writeText(text).then(
      () => addToast(`已复制 ${errors.length} 条错误`, "success"),
      () => addToast("复制失败：剪贴板不可用", "error"),
    );
  }, [errors, addToast]);

  // 将实现暴露给模块级单例（供非组件调用，如 invokeOrToast）
  useEffect(() => {
    toastImpl = addToast;
    dismissImpl = dismissByKey;
    return () => {
      if (toastImpl === addToast) toastImpl = null;
      if (dismissImpl === dismissByKey) dismissImpl = null;
    };
  }, [addToast, dismissByKey]);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast 容器：右下角堆叠，z-[2000] 在 Header 之上，错误项用 role=alert 走 assertive 播报 */}
      <div
        ref={stackRef}
        className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex max-h-[calc(100dvh-2rem)] flex-col gap-2 overflow-y-auto toast-stack"
        role="region"
        aria-label="通知"
        aria-live="polite"
      >
        {errors.length > 0 && (
          <div className="pointer-events-auto flex justify-end">
            <button type="button" onClick={() => setShowErrors(v => !v)} aria-expanded={showErrors}
              className="rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-foreground">
              {showErrors ? "返回通知" : `查看错误（${errors.length}）`}
            </button>
            <button
              type="button"
              onClick={copyAllErrors}
              className="rounded-full border border-border bg-card/95 px-3 py-1 text-xs font-medium text-muted-foreground shadow-pop backdrop-blur-md transition-colors hover:text-foreground"
            >
              复制全部错误（{errors.length}）
            </button>
          </div>
        )}
        {visibleToasts.map((t) => (
          // FLIP 只移动槽位，避免覆盖通知自身的 transform 进退场。
          <div key={t.id}><ToastItemView item={t} onDismiss={removeToast} /></div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItemView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [open, setOpen] = useState(true);
  const [interaction, setInteraction] = useState({ hover: false, focus: false });
  const { mounted, entered } = usePresence(open);
  const hidden = useAppHidden();
  const paused = interaction.hover || interaction.focus || hidden;
  // 错误不自动消失：一条 Rust 报错往往三四十词、折行三四行，3.5 秒读不完；
  // 而它旁边就是唯一的「复制全部错误」入口。留到用户自己关，比抢时间更合理。
  // 其它类型按时长随字数放宽（长文案仍然需要多一点时间）。
  const isError = item.variant === "error";
  const lifetime = isError ? 0 : item.action ? 8000 : Math.max(TOAST_LIFETIME, item.message.length * 90);
  const remaining = useRef(lifetime);

  // 计时归通知自身所有：手动关闭、卸载及暂停均清理同一个时钟。
  useEffect(() => {
    if (!open || paused || lifetime <= 0) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setOpen(false), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [open, paused, lifetime]);

  useEffect(() => { if (!mounted) onDismiss(item.id); }, [mounted, item.id, onDismiss]);

  if (!mounted) return null;

  return (
    <div
      // 错误卡片点空白处不关：想全选复制时鼠标一按就没了。只有 × 能关。
      onClick={isError || item.action ? undefined : () => setOpen(false)}
      onMouseEnter={() => setInteraction(v => ({ ...v, hover: true }))}
      onMouseLeave={() => setInteraction(v => ({ ...v, hover: false }))}
      onFocusCapture={() => setInteraction(v => ({ ...v, focus: true }))}
      onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setInteraction(v => ({ ...v, focus: false })); }}
      data-state={entered ? "open" : "closed"}
      data-exiting={!open || undefined}
      role={isError ? "alert" : "status"}
      className={`pointer-events-auto relative flex w-[320px] max-w-[calc(100vw-2rem)] items-start gap-2.5 overflow-hidden rounded-lg border px-3.5 pb-3.5 pt-3 text-sm font-medium shadow-pop backdrop-blur-md toast ${
        isError || item.action ? "cursor-default" : "cursor-pointer select-none"
      } ${
        isError ? "err" : item.variant === "warning" ? "warn" : ""
      } ${variantStyles[item.variant]}`}
    >
      <span
        className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg ${variantIconBoxes[item.variant]}`}
      >
        <Icon name={variantIcons[item.variant]} size={15} />
      </span>
      <span className="min-w-0 flex-1 break-words py-1 leading-snug">{item.message}</span>
      {item.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            item.action!.onClick();
            setOpen(false);
          }}
          className="shrink-0 self-center rounded-md border border-border px-2 py-1 text-xs font-semibold text-primary hover:bg-accent"
        >
          {item.action.label}
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        aria-label="关闭"
      >
        <Icon name="close" size={12} />
      </button>
      {/* CSS 与 JS 共用暂停条件，剩余时间不会在阅读通知时悄悄流逝。
          错误常驻、没有计时，也就不画这条进度线（否则它停满格会骗人）。 */}
      {lifetime > 0 && (
        <span
          aria-hidden
          className={`toast-countdown absolute bottom-0 left-0 h-[2.5px] rounded-full ${variantProgress[item.variant]}`}
          style={{ animationDuration: `${lifetime}ms`, animationPlayState: paused || !open ? "paused" : "running" }}
        />
      )}
    </div>
  );
}
