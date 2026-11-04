import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { openResourceDownloads } from "../../lib/resourceActions";
import { useOperations } from "../../lib/operations";

/** 常驻入口，面板隐藏后仍能找回后台下载与结果。 */
export function ResourceDownloadEntry() {
  const active = useOperations().some(o => o.key === "resources.ensure" && o.endedAt === undefined);
  return <Button variant="ghost" size="icon" className="wb-header-icon" onClick={openResourceDownloads}
    title={active ? "组件正在下载，查看进度" : "组件下载与管理"} aria-label="组件下载与管理">
    <Icon name={active ? "spinner" : "download"} size={18} className={active ? "animate-spin" : undefined} />
  </Button>;
}
