import type { ContextMenuItem } from "./ContextMenu";
import { openSvnChange } from "../../lib/svnSession";
import type { StatusLetter } from "../../lib/svn";

export function svnCodeMenuItems(path: string, status?: StatusLetter): ContextMenuItem[] {
  if (!status) return [];
  const items: ContextMenuItem[] = [{
    label: status === "C" ? "到版本控制处理冲突" : "到版本控制查看改动",
    separator: true,
    onSelect: () => openSvnChange(path, status === "C" ? "conflict" : "review"),
  }];
  if (!["C", "!", "~"].includes(status)) {
    items.push({ label: "加入本次提交…", onSelect: () => openSvnChange(path, "commit") });
  }
  return items;
}
