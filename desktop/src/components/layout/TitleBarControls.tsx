import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "../ui/icon";

/**
 * 自定义窗口控件：最小化、最大化/还原、关闭（**关闭 = 退出应用**）。
 * 无系统标题栏（decorations: false）时替代原生按钮。
 */

/** 纯浏览器 dev（非 Tauri WebView）里 getCurrentWindow 会同步抛错——兜住返回 null。 */
function tryWin(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function TitleBarControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const win = tryWin();
    if (!win) return;

    // 初始化：查询当前最大化状态
    win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    }).catch(() => {});

    // 监听窗口大小变化，同步最大化状态
    const unlisten = win.onResized(() => {
      win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      }).catch(() => {});
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  const minimize = useCallback(() => {
    tryWin()?.minimize().catch(() => {});
  }, []);

  const toggleMaximize = useCallback(() => {
    tryWin()?.toggleMaximize().catch(() => {});
  }, []);

  const close = useCallback(() => {
    // 必须是 close() 而不是 hide()：
    //
    // 点 X = 退出应用（2026-10-31 起没有托盘、不常驻后台）。而「退出前先问未提交
    // 事务」的逻辑全在后端的 `CloseRequested` 里（main.rs + commands/quit_cmds.rs），
    // hide() 根本不触发那个事件，等于绕过守卫直接把事务丢掉。
    //
    // 注意：这靠 `capabilities/default.json` 里的 `core:window:allow-close`，
    // 没那条权限的话 IPC 会被 ACL 拦掉、按钮变成完全没反应。
    tryWin()?.close().catch(() => {});
  }, []);

  const btnCls = "flex items-center justify-center w-8 h-8 rounded-lg transition-[color,background-color,border-color,transform,box-shadow,opacity] hover:bg-accent hover:text-accent-foreground active:scale-95";

  return (
    <div className="flex items-center gap-0.5" data-tauri-drag-region="false">
      {/* 最小化 */}
      <button
        className={btnCls}
        onClick={minimize}
        title="最小化"
        aria-label="最小化"
      >
        <Icon name="minimize" size={16} />
      </button>

      {/* 最大化 / 还原 */}
      <button
        className={btnCls}
        onClick={toggleMaximize}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
      >
        <Icon name={maximized ? "restore" : "maximize"} size={16} />
      </button>

      {/* 关闭（= 退出应用；有未提交的事务会先弹确认） */}
      <button
        className={`${btnCls} hover:bg-destructive hover:text-destructive-foreground`}
        onClick={close}
        title="退出"
        aria-label="退出"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
