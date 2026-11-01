import { useEffect, useRef } from "react";
import { captureQuietly } from "../lib/localHistory";
import { isAppHidden, subscribeAppVisibility } from "../lib/appVisibility";

/**
 * 本地历史的兜底归档调度：**保存前**的那一版由 `fileSave.saveOne` 负责（见那里），
 * 这个 hook 补两个漏点：
 *
 * 1. **切文件 / 关编辑器**：用户在 A 文件里改了一下午没保存，切走时把磁盘上的
 *    A 归档一版。写在前一个 activePath 的 effect cleanup 里——路径变化和组件
 *    卸载走同一条路，不会漏。
 * 2. **5 分钟兜底**：忘了保存、或者被外部工具（SVN update / 另一个编辑器）
 *    改了磁盘，定时把磁盘现状抓一版。有 sha 去重，内容没变不会产生新版本。
 *
 * 全部 fire-and-forget：失败只 console.warn，绝不影响用户操作（历史是保险丝）。
 */

/** 兜底间隔。5 分钟是「最多丢 5 分钟」与「后台 IO 几乎无感」的折中。 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function useLocalHistorySweep(activePath: string | null) {
  const pathRef = useRef(activePath);
  pathRef.current = activePath;

  // 切文件：归档上一个文件（cleanup 里拿的是旧 activePath，正是我们要的）。
  // 组件卸载（切页关编辑器）同样触发，等于「离开编辑器前抓一版」。
  useEffect(() => {
    if (!activePath || activePath.includes("://")) return; // jdt:// 等虚拟路径没有磁盘内容
    return () => captureQuietly(activePath);
  }, [activePath]);

  // 兜底轮询：只挂载时定一次时，路径从 ref 读（避免每切文件重定时）。
  // 窗口最小化期间不扫盘：归档是后台保险丝，用户看不见时烧磁盘没有收益。
  // 恢复可见时补扫一次，否则最长要再等一个完整间隔。
  useEffect(() => {
    const sweep = () => {
      if (isAppHidden()) return;
      const p = pathRef.current;
      if (p && !p.includes("://")) captureQuietly(p);
    };
    const id = setInterval(sweep, SWEEP_INTERVAL_MS);
    let wasHidden = isAppHidden();
    const off = subscribeAppVisibility(() => {
      const now = isAppHidden();
      if (wasHidden && !now) sweep();
      wasHidden = now;
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, []);
}
