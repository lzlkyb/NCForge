import { useState } from "react";
import type { CleanReport } from "../lib/compile";
import { applyClean, cleanTmpBuild, dryRunClean, reindexBuild } from "../lib/buildMaintenance";
import { toast } from "../components/ui/toast";

/**
 * 清理 / 重编 / 重建索引的确认状态。
 *
 * 为什么先 dry-run 再确认：产物数量、输出目录、删不掉的文件都必须先摆出来。
 * 只说「将清理产物」的确认框等于没有信息，用户只能盲点。
 *
 * 重编的「编」仍由 `useModuleCompile` 执行（它负责日志、取消、面板），
 * 这里只负责确认和调用。
 */
export interface BuildConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  reports: CleanReport[];
  run: () => Promise<void>;
}

export interface BuildMaintenance {
  pending: BuildConfirmState | null;
  askClean: (path?: string, module?: string) => Promise<void>;
  askRebuild: (path?: string, module?: string) => Promise<void>;
  askReindex: () => void;
  cleanTmp: () => void;
  cancel: () => void;
  confirm: () => void;
}

export function useBuildMaintenance({
  rebuildModule,
  rebuildAll,
}: {
  rebuildModule: (path: string) => void;
  rebuildAll: () => void;
}): BuildMaintenance {
  const [pending, setPending] = useState<BuildConfirmState | null>(null);

  const dry = async (path?: string): Promise<CleanReport[] | null> => {
    try {
      return await dryRunClean(path);
    } catch (e) {
      toast(`无法统计将清理的产物：${e}`, "error");
      return null;
    }
  };

  const askClean = async (path?: string, module?: string) => {
    const reports = await dry(path);
    if (!reports) return;
    setPending({
      title: module ? `清理模块 ${module} 的编译产物？` : "清理全部模块的编译产物？",
      description: describe(reports),
      confirmLabel: "清理",
      reports,
      run: () => applyClean(path).then(() => undefined),
    });
  };

  const askRebuild = async (path?: string, module?: string) => {
    const reports = await dry(path);
    if (!reports) return;
    setPending({
      title: module ? `清理并重编模块 ${module}？` : "清理并重编全部模块？",
      description: `${describe(reports)}然后全量重编；会重新生成 class 与构建清单。`,
      confirmLabel: "清理并重编",
      reports,
      run: async () => {
        if (path) rebuildModule(path);
        else rebuildAll();
      },
    });
  };

  const askReindex = () => {
    setPending({
      title: "重建类索引？",
      description:
        "会删除类索引文件与全部构建清单（不删 class 产物）。下次编译要重新扫描全部 jar，首轮会明显变慢；只有在补全 / 跳转异常或怀疑索引过期时才需要。",
      confirmLabel: "重建索引",
      reports: [],
      // 确认框只关心「有没有做完」，失败原因由 buildMaintenance 自己 toast 与设置页错误条负责
      run: async () => { await reindexBuild(); },
    });
  };

  return {
    pending,
    askClean,
    askRebuild,
    askReindex,
    cleanTmp: () => void cleanTmpBuild(),
    cancel: () => setPending(null),
    // 先清确认框再执行：执行期间有进度 / 日志反馈，确认框留着会挡住面板
    confirm: () => {
      const run = pending?.run;
      setPending(null);
      if (run) void run();
    },
  };
}

function describe(reports: CleanReport[]): string {
  const removed = reports.reduce((n, r) => n + r.removed, 0);
  const failed = reports.reduce((n, r) => n + r.failed.length, 0);
  const unknown = reports.reduce((n, r) => n + r.unknownCount, 0);
  const outputs = [...new Set(reports.flatMap((r) => r.outputs))];
  const scope = reports.length === 1 ? `模块 ${reports[0].module}` : `${reports.length} 个模块`;
  const parts = [`${scope}：将删除 ${removed} 个 class 文件。`];
  if (outputs.length) parts.push(`输出目录：${outputs.slice(0, 3).join("、")}${outputs.length > 3 ? " 等" : ""}。`);
  if (failed) parts.push(`其中 ${failed} 个当前删不掉；清理会在第一个失败处停下。`);
  if (unknown) parts.push(`另有 ${unknown} 个产物无法映射回源码，会保留。`);
  parts.push("不会删除源码，也不会删除输出目录本身。");
  return parts.join(" ");
}
