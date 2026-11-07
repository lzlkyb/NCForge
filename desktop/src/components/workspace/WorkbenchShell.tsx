import { lazy, Suspense, useRef, type ReactNode } from "react";
import { WorkbenchFrame } from "./WorkbenchFrame";
import { useFileSlot } from "./useFileSlot";
import { useWorkbenchDock } from "./WorkbenchDock";
import { ViewActivityContext } from "../../lib/viewActivity";
import { Skeleton } from "../ui/Skeleton";

// 文件页带着 Monaco（数 MB）。只有真的进过文件页才下载——外壳自己不认识编辑器。
const FilesTab = lazy(() => import("../tabs/FilesTab").then((m) => ({ default: m.FilesTab })));

/**
 * 冷启动骨架。
 *
 * 原先 `<Suspense fallback={null}>`：FilesTab 的 chunk 下载期间所有 portal 宿主都空，
 * `:empty` 又把标签条和底栏收起，主区一片纯白，读屏也全程无声（P1-21）。
 * 这里把骨架投进外壳的真实槽位，等 FilesTab 挂载后由它的 portal 自然替换。
 * 没有 dock（单测里单独渲染外壳）时直接返回 null，避免骨架掉到状态栏下方。
 */
function ShellSkeleton() {
  const dock = useWorkbenchDock();
  const slot = useFileSlot();
  if (!dock) return null;
  return (
    <>
      {slot("tree", (
        <div className="wb-skeleton-tree" role="status" aria-label="正在加载文件树">
          {[78, 62, 88, 54, 71, 46].map((w, i) => (
            <Skeleton key={i} className="wb-sk-line" style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
      {slot("tabs", (
        <div className="wb-skeleton-tabs" role="status" aria-label="正在加载文件标签">
          <Skeleton className="wb-sk-tab" /><Skeleton className="wb-sk-tab" />
        </div>
      ))}
      {slot("editor", (
        <div className="wb-skeleton-editor" role="status" aria-label="正在加载编辑器">
          {[42, 76, 58, 88, 33, 64].map((w, i) => (
            <Skeleton key={i} className="wb-sk-line" style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
      {slot("status", (
        <div className="wb-skeleton-status" role="status" aria-label="正在加载状态栏">
          <Skeleton className="wb-sk-line" style={{ width: 180 }} />
        </div>
      ))}
    </>
  );
}

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
 *
 * `ViewActivityContext.Provider`：文件页常驻、不包 ActivityPanel，它里面的
 * 弹框以前 `useViewActive()` 恒为 true，切到数据库页后仍浮在上面吞快捷键。
 * 这里把「活动」明确绑定成 activeTab === "files"（P1-17）。
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
            <ViewActivityContext.Provider value={activeTab === "files"}>
              <Suspense fallback={<ShellSkeleton />}>
                <FilesTab activeTool={activeTab} />
              </Suspense>
            </ViewActivityContext.Provider>
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
