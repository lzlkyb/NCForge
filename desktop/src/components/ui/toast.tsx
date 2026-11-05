import { useState, useCallback, useEffect, useRef, createContext, useContext, type ReactNode } from "react";
import { Icon, type IconName } from "./icon";
import { usePresence } from "../../hooks/usePresence";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useAppHidden } from "../../lib/appVisibility";

type ToastVariant = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
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
let toastImpl: ((message: string, variant?: ToastVariant) => void) | null = null;

export function toast(message: string, variant: ToastVariant = "info") {
  toastImpl?.(message, variant);
}

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

  const addToast = useCallback((message: string, variant: ToastVariant = "info") => {
    const id = ++toastId;
    setToasts((prev) => {
      // 同一条消息只留最新一份（连点「重试」会刷出一屏一模一样的通知）；
      // 换新 id 让倒计时与进场动画重新开始，而不是静默续期
      const rest = prev.filter((t) => t.message !== message || t.variant !== variant);
      const next = [...rest, { id, message, variant }];
      // 显示上限不能删除未处理错误；普通通知仅保留最近几条。
      const ordinary = next.filter(t => t.variant !== "error").slice(-MAX_TOASTS);
      return next.filter(t => t.variant === "error" || ordinary.includes(t));
    });
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // 批量失败时用户最想要的是「把这一串贴给同事/日志」，逐条复制不现实。
  const errors = toasts.filter((t) => t.variant === "error");
  const visibleToasts = showErrors && errors.length > 0 ? errors : toasts.slice(-MAX_TOASTS);
  const copyAllErrors = useCallback(() => {
    const text = errors.map((t) => t.message).join("\n");
    navigator.clipboard.writeText(text).then(
      () => addToast(`已复制 ${errors.length} 条错误`, "success"),
      () => addToast("复制失败：剪贴板不可用", "error"),
    );
  }, [errors, addToast]);

  // 将实现暴露给模块级单例（供非组件调用，如 invokeOrToast）
  useEffect(() => {
    toastImpl = addToast;
    return () => { if (toastImpl === addToast) toastImpl = null; };
  }, [addToast]);

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
  const lifetime = isError ? 0 : Math.max(TOAST_LIFETIME, item.message.length * 90);
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
      onClick={isError ? undefined : () => setOpen(false)}
      onMouseEnter={() => setInteraction(v => ({ ...v, hover: true }))}
      onMouseLeave={() => setInteraction(v => ({ ...v, hover: false }))}
      onFocusCapture={() => setInteraction(v => ({ ...v, focus: true }))}
      onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setInteraction(v => ({ ...v, focus: false })); }}
      data-state={entered ? "open" : "closed"}
      data-exiting={!open || undefined}
      role={isError ? "alert" : "status"}
      className={`pointer-events-auto relative flex w-[320px] max-w-[calc(100vw-2rem)] items-start gap-2.5 overflow-hidden rounded-lg border px-3.5 pb-3.5 pt-3 text-sm font-medium shadow-pop backdrop-blur-md toast ${
        isError ? "cursor-default" : "cursor-pointer select-none"
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
