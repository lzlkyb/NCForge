import { useCallback, useEffect, useState } from "react";
import { useAppHidden } from "./appVisibility";
import { invoke } from "./tauri";

/** 与 Rust `content_pack::PackStatus` 的 camelCase 字段一一对应。 */
export interface SearchPackStatus {
  /** 主工作区的包已就绪。 */
  ready: boolean;
  /** 正在建某一个根的包。 */
  building: boolean;
  root: string;
  files: number;
  chunks: number;
  builtAt: number;
  bytes: number;
  /** 排队待建的根数（主工作区 + 依赖工程）。 */
  pending: number;
  /** 进程里已加载的包数。 */
  packedRoots: number;
  lastError: string | null;
}

export function searchPackStatus(): Promise<SearchPackStatus> {
  return invoke<SearchPackStatus>("search_pack_status");
}

/**
 * 首次打开一个工作区时，建包要逐个读 8 千多个文件（冷缓存约两分钟）。
 * 这段时间搜索仍走磁盘——不说一声的话，用户只会觉得「又慢回去了」。
 *
 * 不用 react-query：搜索面板的组件测试里没有 QueryClientProvider，而这里要的只是
 * 一个「建完就停」的自限轮询。轮询只在没建好 / 队列非空时存在，窗口不可见
 * 一律停（`useAppHidden`）；换工作区或发起搜索时由调用方 `refresh()` 唤醒。
 */
export function useSearchPackStatus(active: boolean) {
  const hidden = useAppHidden();
  const [status, setStatus] = useState<SearchPackStatus | null>(null);
  const [wake, setWake] = useState(0);
  const refresh = useCallback(() => setWake((n) => n + 1), []);

  useEffect(() => {
    if (!active || hidden) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      let s: SearchPackStatus | null = null;
      try {
        s = (await searchPackStatus()) ?? null;
      } catch {
        // 状态只是增值提示，命令不可用时静默，绝不挡住搜索
      }
      if (!alive) return;
      setStatus(s);
      // 稳定了就停：没在造包、队列也空，状态不会再自己变
      const busy = !!s && (s.building || s.pending > 0);
      if (!busy && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [active, hidden, wake]);

  return { status, refresh };
}
