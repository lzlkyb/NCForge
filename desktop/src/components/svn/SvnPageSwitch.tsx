import { Icon, type IconName } from "../ui/icon";
import { svnSession, type SvnPage } from "../../lib/svnSession";

const ITEMS: { key: SvnPage; label: string; icon: IconName }[] = [
  { key: "review", label: "审查改动", icon: "gitBranch" },
  { key: "req", label: "按需求审查", icon: "check" },
  { key: "patch", label: "打包补丁", icon: "package" },
];

/**
 * 版本控制页顶部的视图切换：审查改动 / 按需求审查 / 打包补丁。
 *
 * 低频工作副本操作收进菜单后，视图切换可与工作区工具条共用一行，
 * 文件清单不再为页面切换单独损失一行空间。
 */
export function SvnPageSwitch({ page }: { page: SvnPage }) {
  return (
    <div className="vc-mode" role="tablist" aria-label="版本控制视图">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={page === it.key}
          className="vc-mode-btn"
          data-on={page === it.key || undefined}
          onClick={() => svnSession.set({ page: it.key })}
        >
          <Icon name={it.icon} size={12} />
          {it.label}
        </button>
      ))}
    </div>
  );
}
