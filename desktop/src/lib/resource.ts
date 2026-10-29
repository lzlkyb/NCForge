// 资源包（resource packs）链路的纯逻辑层：类型、错误文案、格式化。
//
// 为什么单独拆一个文件：Context/对话框/设置卡三处都要用这些定义与文案，
// 而它们不依赖 React——单独成文件后 vitest 可以直接测，不用挂组件。
//
// 与 Rust 的对应关系（改一边必须同步另一边）：
//  - `PackSummary`     ↔ commands/resource_cmds.rs 里 resource:available 的 payload
//  - `PackStatusInfo`  ↔ commands/resource_cmds.rs 里 PackStatus（resources_status 返回）
//  - `ResourceErrorCode` ↔ commands/resource_cmds.rs 里 classify() 的返回值
//  - `RESOURCE_ERROR_TEXT` ↔ 同上，code → 用户文案

// ─── 类型 ────────────────────────────

/** 资源置备阶段。比更新链路简单：没有 available/uptodate 的独立 UI 态
 *  （available 直接触发下载对话框；uptodate 等于 idle）。 */
export type ResourcePhase = "idle" | "checking" | "downloading" | "ready" | "error";

/** 缺失包摘要（resource:available 事件的 packs 数组元素）。 */
export interface PackSummary {
  id: string;
  title: string;
  notes: string;
  /** 清单声明的字节数 */
  size: number;
}

/** 单个包的本地状态（resources_status 返回元素）。 */
export interface PackStatusInfo {
  id: string;
  title: string;
  notes: string;
  /** installed = 外部已安装；legacy = 旧安装包认领；missing = 缺失 */
  state: "installed" | "legacy" | "missing";
  /** 已安装版本（内容寻址串，如 sha 前 12 位）；legacy/missing 为 null */
  version: string | null;
  /** 本地记录的实际字节数（下载 = 实收总长；legacy = 旧目录实测）；老记录没记过、或缺失时为 null */
  size: number | null;
}

/** 后端 `resource:error` 事件的 payload（Rust 侧 resource_cmds.rs 组装）。
 *  `installed` / `adoptedLegacy` 是本次失败前已完成的部分——后端 ensure_packs
 *  换源重试时会跳过它们，前端据此显示「N/3 已就绪」。 */
export interface ResourceErrorPayload {
  message: string;
  code?: string;
  installed?: { id: string; version: string }[];
  adoptedLegacy?: string[];
}

/** 后端 `resource:ready` 事件的 payload（成功路径；与 error 共用字段定义）。 */
export interface ResourceReadyPayload {
  installed: { id: string; version: string }[];
  adoptedLegacy: boolean;
}

/** 后端 `resource:error` 的机器可读原因码（Rust 侧 classify() 产出）。 */
export type ResourceErrorCode =
  | "signature"
  | "corrupt"
  | "manifest"
  | "config"
  | "timeout"
  | "network"
  | "unknown";

/** code → 用户文案。键必须与 Rust 侧 classify() 的返回值一一对应。 */
export const RESOURCE_ERROR_TEXT: Record<ResourceErrorCode, string> = {
  // 包被篡改或下载损坏——与「网络不好」必须区分，重试通常无效，换源才有用
  signature: "组件包校验失败，已停止安装；请重试，若反复失败请联系维护者",
  // 包本身有问题（或源被投毒）
  corrupt: "组件包内容不完整，已停止安装；请重试，若反复失败请联系维护者",
  manifest: "组件源上暂时没有可用的组件信息，请稍后重试",
  config: "组件源配置有误，请联系维护者",
  timeout: "下载组件超时（网络较慢），可重试或更换网络环境",
  network: "无法连接组件服务器，请检查网络或代理设置",
  unknown: "组件下载失败，请重试",
};

/**
 * 后端错误 → 用户文案（与 UpdateContext.friendlyError 同款思路：
 * code 优先，字符串启发式只在旧后端/未知错误时兜底）。
 */
export function resourceFriendlyError(raw: string, code?: string | null): { friendly: string; raw: string } {
  const mapped = code ? RESOURCE_ERROR_TEXT[code as ResourceErrorCode] : undefined;
  if (mapped) return { friendly: mapped, raw };
  const lower = raw.toLowerCase();
  if (lower.includes("sha-256") || lower.includes("不完整")) {
    return { friendly: RESOURCE_ERROR_TEXT.signature, raw };
  }
  if (lower.includes("zip-slip") || lower.includes("路径不合法") || lower.includes("内容不完整")) {
    return { friendly: RESOURCE_ERROR_TEXT.corrupt, raw };
  }
  if (lower.includes("停滞") || lower.includes("超时") || lower.includes("timeout")) {
    return { friendly: RESOURCE_ERROR_TEXT.timeout, raw };
  }
  if (lower.includes("http 4") || lower.includes("解析失败") || lower.includes("url 不合法")) {
    return { friendly: RESOURCE_ERROR_TEXT.manifest, raw };
  }
  if (lower.includes("必须是 https") || lower.includes("endpoints 为空") || lower.includes("协议不支持")) {
    return { friendly: RESOURCE_ERROR_TEXT.config, raw };
  }
  if (lower.includes("全部资源源均失败") || lower.includes("连接") || lower.includes("下载失败")) {
    return { friendly: RESOURCE_ERROR_TEXT.network, raw };
  }
  return { friendly: RESOURCE_ERROR_TEXT.unknown, raw };
}

// ─── 展示辅助 ────────────────────────

/** 字节数 → 人类可读（MB 一位小数；≥100MB 取整，避免 "102.4MB" 这种噪音）。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(0)} MB`;
}

/** 包状态 → 中文标签（设置页徽章用）。 */
export function packStateLabel(state: PackStatusInfo["state"]): string {
  switch (state) {
    case "installed":
      return "已安装";
    case "legacy":
      return "旧版沿用";
    case "missing":
      return "未下载";
  }
}

/** 本地快照是否「全部就绪」（installed + legacy 都算可用——finder 两条路都认）。 */
export function allPacksReady(packs: PackStatusInfo[]): boolean {
  return packs.length > 0 && packs.every((p) => p.state !== "missing");
}
