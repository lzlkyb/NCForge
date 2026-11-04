import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { ScopeChip } from "./ScopeChip";
import type { ManifestAudit } from "../../lib/ncManifest";
import type { ComponentOption } from "../../lib/searchScope";

/**
 * 「组件」范围：范围芯片 + 组件清单菜单。
 *
 * 为什么是清单而不是输入框：工程根下 30 来个业务组件，名字都是 `bill` / `gl` / `ic`
 * 这种两三个字母，记不全；勾选列表还能顺带显示中文名（`票据`）。
 *
 * manifest 读不到时（还没有工程、或工程根没有 `manifest.xml`）整个控件置灰并说明原因，
 * 不做「点了没反应」的按钮——这个能力本来就依赖登记表，没有就是没有。
 *
 * 底部那行「另有 N 个模块未登记」是**解释**：newar 磁盘上 59 个带 `src/` 的模块、
 * 登记表只有 32 个，`aim` / `cmp` 这些不在清单里不是 bug。不把它做成告警清单——
 * 登记表由 NC 设计器维护，平台/工具模块本来就不该在里面，逐条报警只会变成噪声。
 */
export function ComponentScopeMenu({
  options,
  audit,
  value,
  disabled,
  onPick,
}: {
  options: ComponentOption[];
  /** 登记缺口；`null` = 没有 manifest，整块不显示。 */
  audit: ManifestAudit | null;
  /** 当前选中的组件目录名。 */
  value: string | null;
  disabled: boolean;
  onPick: (name: string) => void;
}) {
  const label = value ? `组件 ${value}` : "组件";
  const title = disabled
    ? "按组件搜索不可用：工程根的 manifest.xml 里没有登记业务组件"
    : value
      ? `只在这个业务组件（${value}）里搜索，点这里换一个`
      : "按业务组件搜索：范围取该组件的模块目录";

  return (
    <Menu
      portal
      width="w-64"
      trigger={(open, toggle) => (
        <ScopeChip
          on={value !== null && !disabled}
          disabled={disabled}
          onClick={toggle}
          title={title}
          hasPopup
          expanded={open}
        >
          <span className="inline-flex items-center gap-0.5">
            {label}
            <Icon name="chevronDown" size={10} />
          </span>
        </ScopeChip>
      )}
    >
      {(close) => (
        <>
          {options.length === 0 && (
            <div className="px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
              manifest.xml 里没有登记业务组件
            </div>
          )}
          {options.map((o) => (
            <MenuItem
              key={o.name}
              label={
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-mono text-[12.5px]">{o.name}</span>
                  {o.label && (
                    <span className="truncate text-[11px] text-muted-foreground">{o.label}</span>
                  )}
                </span>
              }
              checked={o.name === value}
              onClick={() => {
                onPick(o.name);
                close();
              }}
            />
          ))}
          {/* 原生 `<details>`：不需要自管展开状态，菜单关掉再打开也不会留在展开态 */}
          {audit && audit.unregistered.length > 0 && (
            <details className="mt-1 border-t border-border pt-0.5">
              <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground hover:text-foreground">
                另有 {audit.unregistered.length} 个模块未在 manifest 登记
              </summary>
              <div className="px-2.5 pb-1.5">
                <p className="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  登记表由 NC 设计器维护。没登记的模块照样能搜索、能编译，只是不能当选这里的「组件」范围。
                </p>
                <div className="break-words font-mono text-[11px] leading-relaxed text-foreground">
                  {audit.unregistered.join("  ")}
                </div>
              </div>
            </details>
          )}
        </>
      )}
    </Menu>
  );
}
