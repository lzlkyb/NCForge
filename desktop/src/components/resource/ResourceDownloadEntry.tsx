import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { openResourceDownloads } from "../../lib/resourceActions";
import { useOperationActive } from "../../lib/operations";

/** 常驻入口，面板隐藏后仍能找回后台下载与结果。 */
export function ResourceDownloadEntry() {
  const active = useOperationActive("resources.ensure");
  return <Button variant="ghost" size="icon" className="wb-header-icon" onClick={openResourceDownloads}
    title={active ? "组件正在下载，查看进度" : "组件下载与管理"} aria-label="组件下载与管理">
    <Icon name="download" size={18} />
  </Button>;
}
