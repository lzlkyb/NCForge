/**
 * 状态栏「当前需求」（按需求审查 P1）。
 *
 * 只影响「你在 NCForge 里手改保存」的文件归属；AI 的改动以 AI 自己声明的需求为准。
 * 没有任何需求时只在版本控制页显示（方便新建），别的页不占状态栏。
 */
import { Menu, MenuItem } from "../ui/Menu";
import { toast } from "../ui/toast";
import { createRequirement } from "../../lib/reqActions";
import { reqSetCurrent, useRequirements } from "../../lib/requirements";

export function ReqStatusChip({ activeTool }: { activeTool: string }) {
  const { view } = useRequirements();
  const open = view.reqs.filter((r) => r.status === "open");
  if (!open.length && activeTool !== "svn") return null;
  const current = open.find((r) => r.id === view.current) ?? null;
  const choose = (id: string | null) => { void reqSetCurrent(id).catch((e) => toast(`切换当前需求失败：${String(e)}`, "error")); };
  return <Menu portal align="left" width="w-72" trigger={(isOpen, toggle) =>
    <button type="button" className="wb-status-btn wb-status-req" aria-haspopup="menu" aria-expanded={isOpen} onClick={toggle}
      title="在 NCForge 里手改保存的文件归到这个需求；AI 的改动以 AI 声明的需求为准">
      ◎ 当前需求：<span>{current?.name ?? "未选"}</span>
    </button>}>
    {close => <>
      <div className="px-2.5 py-1 text-xs text-muted-foreground">手改保存的文件归到：</div>
      {open.map((r) => <MenuItem key={r.id} label={r.name} checked={r.id === current?.id} onClick={() => { close(); choose(r.id); }} />)}
      <MenuItem label="不归入任何需求" hint="进未认领" checked={!current} onClick={() => { close(); choose(null); }} />
      <MenuItem label="＋ 新建需求…" hint="名字 = 补丁名去掉日期" onClick={() => { close(); void createRequirement().then((id) => { if (id) choose(id); }); }} />
    </>}
  </Menu>;
}
