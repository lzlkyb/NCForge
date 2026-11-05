import { lazy, Suspense, useRef, type ReactNode } from "react";
import { WorkbenchFrame } from "./WorkbenchFrame";

// 文件页带着 Monaco（数 MB）。只有真的进过文件页才下载——外壳自己不认识编辑器。
const FilesTab = lazy(() => import("../tabs/FilesTab").then((m) => ({ default: m.FilesTab })));

/**
 * 工作台外壳。
 *
 * 拆这一层的目的只有一句话：**「文件页」不再是「所有页面的宿主」**。
 * 以前 App 把 7 个 ActivityPanel 塞进 `<FilesTab tool={…}>`，于是：
 *  - 进设置 / 搜索也得先下载带 Monaco 的 FilesTab；
 *  - 只有最外层一个 ErrorBoundary，任一工具页抛错就卸载整个工作台；
 *  - `renderTab` 的 default 又返回 `<FilesTab/>`，是个现成的递归坑。
 *
 * 现在：外壳持有 `WorkbenchFrame`（布局、停靠宿主、尺寸记忆），各工具页的
 * ActivityPanel 由 App 交进来常驻保活，文件页自己也只是一个「往固定槽位里
 * portal 内容」的普通面板。文件页一旦挂上就不再卸载——标签、编辑状态、
 * Monaco 实例都在里面，卸载等于把用户的编辑器扔了。
 */
export function WorkbenchShell({ activeTab, tool }: { activeTab: string; tool: ReactNode }) {
  // 渲染期写 ref 在这里是幂等的（StrictMode 双渲染也不会产生副作用），
  // 用它避免「记住访问过」再触发一轮渲染。
  const seenFiles = useRef(activeTab === "files");
  if (activeTab === "files") seenFiles.current = true;

  return (
    <WorkbenchFrame
      activeTool={activeTab}
      tool={
        <>
          {seenFiles.current && (
            <Suspense fallback={null}>
              <FilesTab activeTool={activeTab} />
            </Suspense>
          )}
          {tool}
        </>
      }
      // 文件页的槽位内容全部由 FilesTab 用 portal 注入，这里只留空容器。
      tree={null}
      tabs={null}
      editor={null}
      output={null}
      status={null}
    />
  );
}
