import type { RESOURCE_IDS } from "./resource";

export type ResourceId = (typeof RESOURCE_IDS)[number];

/** 只认后端的组件缺失错误，网络、Java 配置等错误不能误导用户下载。 */
export function missingResourceId(error: unknown): ResourceId | null {
  const message = String(error ?? "");
  if (message.includes("找不到 SVN 组件")) return "svnkit";
  if (message.includes("找不到反编译组件")) return "cfr";
  if (message.includes("找不到 Java 编译器组件")) return "ecj";
  if (message.includes("找不到可用的 Java 语言服务组件")) return "jdtls";
  return null;
}

export const RESOURCE_DOWNLOAD_LABELS: Record<ResourceId, string> = {
  svnkit: "下载 SVN 组件", cfr: "下载反编译组件",
  ecj: "下载 Java 编译器", jdtls: "下载代码智能组件",
  ncdb: "下载数据库组件",
};
