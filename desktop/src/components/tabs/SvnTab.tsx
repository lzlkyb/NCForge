import { useEffect, useRef } from "react";
import "../../svn.css";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { SvnPageSwitch } from "../svn/SvnPageSwitch";
import { SvnReview } from "../svn/SvnReview";
import { PatchWorkspace } from "./PatchWorkspace";
import { ReqReview } from "../svn/ReqReview";
import { useSvnView } from "../../lib/svnSession";

export function SvnTab({
  onOpenFile,
  onNavigate,
}: {
  onOpenFile: (path: string) => void;
  onNavigate: (tab: string) => void;
}) {
  const dock = useWorkbenchDock();
  const { page } = useSvnView();
  const dockRef = useRef(dock);
  dockRef.current = dock;

  // 补丁视图的内容全在文档区：切过去时若停在源码视图，屏幕上只剩一个空侧栏。
  // 只在「切到补丁」时打开一次——用户随后点文件标签回去看源码，不该被拽回来。
  useEffect(() => {
    if (page !== "review") dockRef.current?.showDocument();
  }, [page]);

  return (
    <div className="vc-page" data-page={page}>
      <DockRegion region="toolbar"><SvnPageSwitch page={page} /></DockRegion>
      {page === "patch"
        ? <PatchWorkspace onNavigate={onNavigate} />
        : page === "req"
          ? <ReqReview onOpenFile={onOpenFile} />
          : <SvnReview onOpenFile={onOpenFile} />}
    </div>
  );
}
