import { useEffect, useRef } from "react";
import "../../svn.css";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { SvnPageSwitch } from "../svn/SvnPageSwitch";
import { SvnReview } from "../svn/SvnReview";
import { PatchWorkspace } from "./PatchWorkspace";
import { useSvnView } from "../../lib/svnSession";
import { svnSession } from "../../lib/svnSession";

/**
 * 版本控制页。
 *
 * 页签层面只剩一个入口，页内分两个视图：审查改动（左改动列表 / 右差异）与
 * 打包补丁（左补丁清单 / 右落位预览）。两者读的是同一份未提交改动，
 * 分开成两个页签等于把同一次工作副本扫描跑两遍、还让「改完 → 打包」必须跨页。
 *
 * 这个文件只做视图路由与文档区开合；两个视图各自持有自己的状态机，
 * 切走时整块卸载——补丁视图的草稿落在 localStorage / 模块仓，不会丢。
 */
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
    if (page === "patch") dockRef.current?.showDocument();
  }, [page]);

  return (
    <div className="vc-page" data-page={page}>
      <DockRegion region="sidebar">
        <SvnPageSwitch page={page} />
      </DockRegion>
      {page === "patch"
        ? <><DockRegion region="toolbar"><button type="button" className="pk-btn vc-back-review" onClick={() => svnSession.set({page:"review"})}>返回审查</button></DockRegion><PatchWorkspace onNavigate={onNavigate} /></>
        : <SvnReview onOpenFile={onOpenFile} />}
    </div>
  );
}
