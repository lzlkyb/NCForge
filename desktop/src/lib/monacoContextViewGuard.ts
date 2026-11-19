import type { monaco } from "./monacoSetup";

interface ContextViewLike {
  view: HTMLElement | null;
  doLayout(): void;
}

const guarded = new WeakSet<ContextViewLike>();
let wired = false;

/**
 * Monaco 0.52 的 fixed 定位 ContextView 在 `doLayout` 里用「目标坐标 − 视图当前坐标」
 * 换算 `style.top/left`（contextview.js）。视图已停在目标位时再 `layout()` 会把坐标
 * 写回 0 —— 弹层甩到窗口左上角，下一次布局又弹回，表现为「乱跳」。
 * 命中面：联查/代码动作菜单（焦点变化主动 relayout）、编辑器右键菜单（窗口 resize
 * 触发上游 `onDidLayoutContainer → layout()`）等一切走 fixed ContextView 的浮层。
 * suggest/参数提示/ghost chip 走 contentWidget（编辑器按锚点重算），不受影响。
 *
 * 守卫：doLayout 前把 fixed 视图归零，换算减数恒为 0；归零与布局同任务，中间不绘制。
 * 服务是进程级单例、全编辑器共享，故用 onDidCreateEditor（含 diff 的两个内编辑器）
 * 只装一次；不卸载——服务与页面同寿命，卸载反而会在多编辑器间留下未守卫窗口。
 */
export function wireFixedContextViewGuard(api: typeof monaco): void {
  if (wired) return;
  wired = true;
  api.editor.onDidCreateEditor(editor => {
    // 0.52 不把 contextViewService 挂在编辑器实例上；codeAction 控制器持有的
    // actionWidgetService 注入的就是进程级单例（右键菜单等共用同一份）。
    const controller = editor.getContribution("editor.contrib.codeActionController") as
      { _actionWidgetService?: { _contextViewService?: { contextView?: ContextViewLike } } } | null;
    const service = controller?._actionWidgetService?._contextViewService;
    const cv = service?.contextView;
    if (!cv || guarded.has(cv)) return;
    guarded.add(cv);
    const orig = cv.doLayout;
    cv.doLayout = () => {
      if (cv.view && cv.view.style.position === "fixed") {
        cv.view.style.top = "0px";
        cv.view.style.left = "0px";
      }
      orig.call(cv);
    };
  });
}