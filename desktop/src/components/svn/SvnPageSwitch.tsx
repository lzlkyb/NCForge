import { Icon, type IconName } from "../ui/icon";
import { svnSession, type SvnPage } from "../../lib/svnSession";
import { useWorkbenchDock } from "../workspace/WorkbenchDock";
import { Menu, MenuItem } from "../ui/Menu";

const ITEMS: { key: SvnPage; label: string; icon: IconName }[] = [
  { key: "review", label: "本地改动", icon: "gitBranch" },
  { key: "remote", label: "远端更新", icon: "download" },
  { key: "history", label: "版本历史", icon: "history" },
];

export function SvnPageSwitch({ page }: { page: SvnPage }) {
  const dock = useWorkbenchDock();
  const open = (next: SvnPage) => {
    svnSession.set({ page:next, ...(next === "history" && page !== "history" ? {historyRevision:null} : {}) });
    dock?.showDocument();
  };
  const localPage = page === "req" || page === "patch" ? "review" : page;
  return (
    <nav className="vc-mode" aria-label="版本控制视图">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          aria-current={localPage === it.key ? "page" : undefined}
          className="vc-mode-btn"
          data-on={localPage === it.key || undefined}
          onClick={() => open(it.key)}
        >
          <Icon name={it.icon} size={12} />
          <span>{it.label}</span>
        </button>
      ))}
      <Menu portal width="w-44" trigger={(expanded,toggle) => <button type="button" className="vc-mode-btn" aria-label="需求审查与补丁" aria-haspopup="menu" aria-expanded={expanded} onClick={toggle}><Icon name="chevronDown" size={13}/></button>}>
        {close => <>
          <MenuItem label="按需求审查" icon="check" checked={page === "req"} onClick={() => { close(); open("req"); }}/>
          <MenuItem label="打包补丁" icon="package" checked={page === "patch"} onClick={() => { close(); open("patch"); }}/>
        </>}
      </Menu>
    </nav>
  );
}
