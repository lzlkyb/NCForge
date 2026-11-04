import { useCallback, useEffect, useRef, useState } from "react";
import { trackOperation } from "../../lib/operations";
import { invokeOrToast } from "../../lib/tauri";
import { ToggleRow } from "../ui/ToggleRow";

/**
 * 开机自启开关，外加「这个值是什么时候从系统读的」。
 *
 * 自启的真源是注册表 / LaunchAgent，配置文件里的 `autostart_enabled` 只是镜像：
 * 用户在系统设置或安装器里改过，镜像不会自动同步。旧实现只读一次、还没刷新入口，
 * 页面开着时状态就可能已经过时——这里把读取时刻显式写出来，并给一个重新读取。
 */
export function AutostartRow({ onSaved }: { onSaved: (enabled: boolean) => Promise<void> | void }) {
  const [on, setOn] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // busy 是渲染状态，同一事件循环里连续两次点击读到的还是旧值；写注册表和
  // 重新读取必须串行，否则后到的旧响应会把界面改成与注册表相反的状态。
  const lock = useRef(false);

  const read = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const enabled = await invokeOrToast<boolean>("get_autostart", undefined, "读取开机自启状态失败");
      if (typeof enabled === "boolean") {
        setOn(enabled);
        setAt(Date.now());
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const change = async (v: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    // 乐观置值 + 失败回滚：set_autostart 返回最终生效状态，拿不到布尔值就是失败了。
    setOn(v);
    try {
      const finalState = await trackOperation({ key: "settings.autostart", label: "保存开机自启设置", page: "settings" }, () => invokeOrToast<boolean>("set_autostart", { enabled: v }, "设置开机自启失败"), result => ({ state: typeof result === "boolean" ? "success" : "failed", detail: typeof result === "boolean" ? undefined : "系统未确认开机自启设置" }));
      if (typeof finalState !== "boolean") {
        setOn(!v);
        return;
      }
      setOn(finalState);
      setAt(Date.now());
      await onSaved(finalState);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <ToggleRow
        id="appearance-autostart"
        label="开机自启"
        keywords={["启动", "登录", "autostart"]}
        sub="登录系统时自动启动（点 X 即退出，不会留在后台）"
        checked={on}
        pending={busy}
        disabled={busy || at === null}
        disabledReason={at === null ? "先重新读取系统状态" : busy ? "正在处理，请稍候" : undefined}
        valueText={at ? (on ? "已开启" : "已关闭") : busy ? "读取中" : "读取失败"}
        onChange={(v) => void change(v)}
      />
      <div className="wb-setting-meta">
        <span>
          {busy
            ? "正在读取系统状态…"
            : at
              ? `读自系统 · ${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}`
              : "还没读到系统状态"}
        </span>
        <button type="button" disabled={busy} onClick={() => void read()}>
          重新读取
        </button>
      </div>
    </>
  );
}
