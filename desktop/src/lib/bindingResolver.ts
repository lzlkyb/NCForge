// 精确解析（常驻 binding resolver）的状态：给设置页显示一行。
//
// 为什么需要它：resolver 失败**没有任何用户可见症状**——表现只是「跳转退回内容搜索」，
// 和「本来就没有这个能力」长得一模一样。这一行负责把「待命 / 就绪 / 退避中」说清楚。
import { useEffect, useState } from "react";
import { invoke } from "./tauri";

/** 与 Rust `bind_resolver::Status` 对应（camelCase）。 */
export interface BindingStatus {
  state: "idle" | "ready" | "backoff";
  queries: number;
  answers: number;
  misses: number;
  failures: number;
  timeouts: number;
  ooms: number;
  spawns: number;
  trimmed: number;
  /** 退避剩余秒数；0 = 不在退避。 */
  backoffRemainingSecs: number;
  lastQueryMs: number | null;
  totalQueryMs: number;
  error: string | null;
}

/**
 * 读一次 resolver 状态；之后每 3s 再问一次（设置页可见期间）。
 *
 * 与 `useFastIndexStatus` 不同：那边只轮询「构建中」，这边常态轮询——查询数是
 * 最直接的「它到底在不在干活」的证据，而设置页停留时间以秒计，3s 一次没有负担。
 */
export function useBindingStatus(active = true): BindingStatus | null {
  const [st, setSt] = useState<BindingStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = await invoke<BindingStatus>("lang_binding_status");
        if (!alive) return;
        setSt(s);
        timer = setTimeout(() => void poll(), 3000);
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

/** 一句话概括，设置页直接用。 */
export function describeBinding(st: BindingStatus): string {
  if (st.state === "backoff") {
    const secs = st.backoffRemainingSecs > 0 ? `（${st.backoffRemainingSecs}s 后重试）` : "";
    return `精确解析：连续失败 ${st.failures} 次，已暂停${secs}${st.error ? ` — ${st.error}` : ""}`;
  }
  if (st.state === "ready") {
    const last = st.lastQueryMs != null ? `，上次 ${st.lastQueryMs}ms` : "";
    return `精确解析：就绪（本次会话 ${st.queries} 次查询，答上 ${st.answers}${last}）`;
  }
  // 待命 + 有错误 = 环境根本装不起来（缺桥 jar / 缺 NC 自带 JDK / classpath 空）。
  // 这时每次跳转都静默退回内容搜索，症状与「从没用过」一模一样——必须说出来，
  // 否则用户只会觉得「精确跳转时好时坏」。
  if (st.error) return `精确解析：不可用 — ${st.error}`;
  return "精确解析：待命（首次跳转时启动，空闲 2 分钟自动退出）";
}
