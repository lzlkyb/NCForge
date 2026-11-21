// 声明索引（Phase 1 快通道）的状态：给设置页显示一行。
//
// 为什么需要它：索引构建失败**没有任何用户可见症状** —— 表现只是「跳转永远退回内容搜索」。
// 用户装了新组件后跳不到类，和索引压根没建起来，在界面上长得一模一样，只能靠这一行区分。
import { useEffect, useState } from "react";
import { invoke } from "./tauri";

export interface FastIndexStatus {
  state: "none" | "building" | "ready" | "failed";
  /** 类型总数（源码 + jar） */
  types: number;
  sourceFiles: number;
  /** jar 侧类型数 */
  jarTypes: number;
  /** 索引落盘时刻（Unix 毫秒） */
  builtAtMs: number;
  /** types.idx 字节数 */
  indexBytes: number;
  /** 上次构建（含复用判定）耗时 */
  buildMs: number | null;
  /** 连续失败次数 */
  failures: number;
  error: string | null;
}

/**
 * 读一次索引状态；构建中时每 3s 再问一次（建完就停）。
 *
 * 不轮询「已就绪」的状态：索引一旦建好就不会自己变，多问只是白耗 IPC。
 */
export function useFastIndexStatus(active = true): FastIndexStatus | null {
  const [st, setSt] = useState<FastIndexStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = await invoke<FastIndexStatus>("lang_fast_status");
        if (!alive) return;
        setSt(s);
        if (s.state === "building") timer = setTimeout(() => void poll(), 3000);
      } catch {
        // 状态只是展示用：拿不到就让这一行不出现，不要打断设置页
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
  return st;
}

/** 29.8 万：给用户看的量级，不追求精确到个位。万以下直接给数字（「7.4 千」不如「7419」直观）。 */
export function fmtCount(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
  return String(n);
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 一句话概括，设置页直接用。 */
export function describeFastIndex(st: FastIndexStatus): string {
  if (st.state === "ready") {
    const when = st.builtAtMs
      ? new Date(st.builtAtMs).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "未知";
    return `声明索引：${fmtCount(st.types)} 个类型（jar ${fmtCount(st.jarTypes)}）· ${fmtBytes(st.indexBytes)} · 建于 ${when}`;
  }
  if (st.state === "building") return "声明索引：正在建立（首次约 20 秒，期间跳转先按类名搜）";
  if (st.state === "failed") {
    const times = st.failures > 1 ? `（已连续失败 ${st.failures} 次，稍后自动重试）` : "";
    return `声明索引：建立失败${times}${st.error ? ` — ${st.error}` : ""}`;
  }
  return "声明索引：尚未建立（打开工作区后自动开始）";
}
