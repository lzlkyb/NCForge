import { Icon, type IconName } from "../ui/icon";
import { svnSession, type SvnPage } from "../../lib/svnSession";

const ITEMS: { key: SvnPage; label: string; icon: IconName }[] = [
  { key: "review", label: "审查改动", icon: "gitBranch" },
  { key: "patch", label: "打包补丁", icon: "package" },
];

/**
 * 版本控制页顶部的视图切换：审查改动 / 打包补丁。
 *
 * 放在侧栏最上方而不是页面工具条里：工具条已经排了 5 个动作按钮，宽度收窄时
 * 连 URL 都要让位；侧栏固定 240px，两个等宽段刚好，而且切换后的列表就在下面，
 * 视线不用来回跳。
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
