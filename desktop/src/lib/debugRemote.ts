// 远程附加的地址输入与持久化。
//
// 表单值存本机 localStorage（端口映射是「这台机器怎么连过去」，不是工作区配置）。
// 校验口径与 Rust `debug::remote_endpoint` 对齐：主机可省略（默认回环），端口必须有。
import type { RemoteEndpoint } from "./debug";

const KEY = "ncforge-debug-remote-endpoint";

export interface RemoteInput {
  host: string;
  port: string;
}

/** 读上次填的地址；没填过就给回环 + 空端口（强制用户确认映射端口）。 */
export function loadRemoteInput(): RemoteInput {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<RemoteInput>;
      return {
        host: typeof v.host === "string" && v.host.trim() ? v.host : "127.0.0.1",
        port: typeof v.port === "string" ? v.port : "",
      };
    }
  } catch {
    // 隐私模式 / 旧数据损坏：用默认值，不影响本次附加
  }
  return { host: "127.0.0.1", port: "" };
}

export function saveRemoteInput(input: RemoteInput): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ host: input.host.trim(), port: input.port.trim() }));
  } catch {
    // 不落盘也能用，只是下次要重填
  }
}

/**
 * 校验输入并给出规范化地址。`error` 非空时 `endpoint` 为 null。
 *
 * 主机留空按 127.0.0.1 处理：最常见的是 SSH 隧道把远端 JDWP 映射到本机端口。
 */
export function parseRemoteInput(hostRaw: string, portRaw: string): {
  endpoint: RemoteEndpoint | null;
  error: string | null;
} {
  const host = hostRaw.trim() || "127.0.0.1";
  if (host.length > 253 || /\s/.test(host)) {
    return { endpoint: null, error: "主机地址不能含空格，且不能超过 253 个字符。" };
  }
  const text = portRaw.trim();
  if (!/^\d+$/.test(text)) {
    return { endpoint: null, error: "端口必须是 1–65535 的整数。" };
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { endpoint: null, error: "端口必须是 1–65535 的整数。" };
  }
  return { endpoint: { host, port }, error: null };
}
