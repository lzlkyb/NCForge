import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";

/**
 * 设置页的渐进披露分组：标题 + 当前值摘要常驻，控件展开才出现。
 *
 * 用途是长表单收口（编辑器一页 9 个控件）：默认只看到三行摘要，值仍然可见，
 * 不必展开就能确认「现在是关还是开」。用原生 `<details>` 的语义换成自管
 * `open`：React 里非受控 details 在重渲染时的行为依赖浏览器，不如自己握状态。
 */
export function SettingsGroup({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** 折叠时也要让人看懂当前配置：用值拼一句短摘要。 */
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDetailsElement>(null);
  // 搜索定位需要同步 React 的展开状态，下一次偏好更新才不会把目标重新折起。
  useEffect(() => {
    const node = ref.current;
    const reveal = () => setOpen(true);
    node?.addEventListener("settings:reveal", reveal);
    return () => node?.removeEventListener("settings:reveal", reveal);
  }, []);
  return (
    <details
      ref={ref}
      className="settings-group"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="settings-group-head">
        <Icon name="chevronRight" size={12} className="settings-group-chevron" />
        <span className="settings-group-title">{title}</span>
        <span className="settings-group-sum" title={summary}>
          {summary}
        </span>
      </summary>
      <div className="settings-group-body">{children}</div>
    </details>
  );
}
