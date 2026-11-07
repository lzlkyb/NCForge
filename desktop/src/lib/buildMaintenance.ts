/**
 * 构建维护动作：清理产物、重建索引、清理临时文件。
 *
 * 与「编译」分开：这些动作不改源码，但会改变产物与清单，所以同样要过编译闸
 * （后端 `CompileSlot` 保证）。这里负责把结果写进会话（编译输出面板）并给出
 * 一句能直接看的总结；确认框的数据来自同一组命令的 dry-run。
 */
import {
  buildCacheInfo,
  buildCleanAll,
  buildCleanModule,
  buildCleanTmp,
  buildReindex,
  type CleanReport,
  type CompileResult,
} from "./compile";
import { getSession, setSession } from "./workspaceSession";
import { trackOperation } from "./operations";
import { ask } from "./dbConfirm";
import { errorToast } from "./errorToast";
import { toast } from "../components/ui/toast";

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** 只统计不删除：确认框显示「将删多少、删哪里、哪些删不掉」。 */
export function dryRunClean(path?: string): Promise<CleanReport[]> {
  return path ? buildCleanModule(path, true).then((r) => [r]) : buildCleanAll(true);
}

/**
 * 清理产物。`path` 为空 = 全部模块。
 *
 * 结果会从 `compileResult` 里移除对应模块的问题与账本——产物都没了，
 * 上一轮的错误不该继续挂在问题面板里（用户会以为还能直接运行）。
 */
export async function applyClean(path?: string): Promise<CleanReport[]> {
  const key = `build.clean:${path ? norm(path) : "all"}`;
  const reports = await trackOperation(
    {
      key,
      label: path ? "清理模块产物" : "清理全部模块产物",
      scope: path ?? getSession().root ?? "工作区",
      page: "files",
      phase: "删除清单里记录的 class",
    },
    async () => {
      const out = path ? [await buildCleanModule(path, false)] : await buildCleanAll(false);
      writeSummary(out);
      return out;
    },
  ).catch((e) => {
    errorToast("清理产物", e);
    return null;
  });
  if (!reports) return [];
  setSession({ panelOpen: true, panelTab: "build" });
  setSession({ compileResult: (prev) => removeModules(prev, reports, getSession().root ?? "") });
  return reports;
}

/** 重建类索引：不删产物，只删索引文件与构建清单；下次编译自动全量。 */
export async function reindexBuild(): Promise<void> {
  try {
    const msg = await trackOperation(
      {
        key: "build.reindex",
        label: "重建类索引",
        scope: getSession().root ?? "工作区",
        page: "files",
        phase: "删除索引文件与构建清单",
      },
      async () => {
        const text = await buildReindex();
        setSession({ compileLog: (l) => [...l, text] });
        return text;
      },
    );
    toast(msg, "success");
  } catch (e) {
    errorToast("重建索引", e);
  }
}

/** 防连点：命令面板是高频入口，一次点击可能重复下发两轮删除。 */
let cleanTmpBusy = false;

/** 清理编译临时文件（只动配置目录下的 ecj 参数文件与原子写残留）。 */
export async function cleanTmpBuild(): Promise<void> {
  if (cleanTmpBusy) {
    toast("正在清理编译临时文件，请稍候", "info");
    return;
  }
  cleanTmpBusy = true;
  try {
    // trackOperation 既有进度 / 结果反馈，也用 spec.key 的 flights 挡同帧连点。
    const r = await trackOperation(
      {
        key: "build.cleanTmp",
        label: "清理编译临时文件",
        scope: getSession().root ?? "工作区",
        page: "files",
        phase: "删除 ecj 参数文件与原子写残留",
      },
      () => buildCleanTmp(),
    );
    const text = r.removed
      ? `已清理 ${r.removed} 个编译临时文件（${formatBytes(r.bytes)}）`
      : "没有需要清理的编译临时文件";
    setSession({ compileLog: (l) => [...l, text] });
    toast(text, "success");
  } catch (e) {
    errorToast("清理编译临时文件", e);
  } finally {
    cleanTmpBusy = false;
  }
}

/** dry-run 计数：只读统计临时文件占用，供确认框显示「将清理多少」，不执行删除。 */
export async function dryRunCleanTmp(): Promise<{ bytes: number }> {
  const info = await buildCacheInfo();
  return { bytes: info.tmpBytes };
}

/**
 * 命令面板入口：先 dry-run 统计、再二次确认、最后带进度执行。
 * 统计失败不挡确认（仍给出「占用未知」的提示），危险动作本身由 cleanTmpBuild 防连点。
 */
export async function askCleanTmp(): Promise<void> {
  let desc = "将清理配置目录下的 ecj 参数文件与原子写残留，不会碰工作区源码；当前统计不到占用。";
  try {
    const { bytes } = await dryRunCleanTmp();
    if (bytes > 0) desc = `将清理配置目录下约 ${formatBytes(bytes)} 的 ecj 参数文件与原子写残留，不会碰工作区源码。`;
  } catch {
    desc = "无法统计临时文件占用，仍要继续清理吗？不会碰工作区源码。";
  }
  const ok = await ask("清理编译临时文件？", desc, "清理", true);
  if (ok) await cleanTmpBuild();
}

function writeSummary(reports: CleanReport[]): void {
  const removed = reports.reduce((n, r) => n + r.removed, 0);
  const failed = reports.reduce((n, r) => n + r.failed.length, 0);
  const unknown = reports.reduce((n, r) => n + r.unknownCount, 0);
  const lines = [
    `清理 ${reports.length} 个模块：删除 ${removed} 个 class${failed ? `，${failed} 个删除失败` : ""}`,
  ];
  if (unknown > 0) lines.push(`有 ${unknown} 个产物没有对应的源码或清单记录，已保留（不猜着删）`);
  for (const r of reports) lines.push(...r.notes.map((n) => `[${r.module}] ${n}`));
  setSession({ panelOpen: true, panelTab: "build", compileLog: (l) => [...l, ...lines] });
  toast(
    failed
      ? `清理完成：删除 ${removed} 个 class，${failed} 个删不掉（见编译输出）`
      : `清理完成：删除 ${removed} 个 class`,
    failed ? "warning" : "success",
  );
}

/** 从合并结果里摘掉这些模块的问题 / 诊断 / 账本。 */
function removeModules(
  prev: CompileResult | null,
  reports: CleanReport[],
  root: string,
): CompileResult | null {
  if (!prev) return null;
  const names = new Set(reports.map((r) => r.module.toLowerCase()));
  const prefixes = [...names].map((m) => `${norm(root)}/${m}/`);
  const inAffected = (file: string) => prefixes.some((p) => norm(file).startsWith(p));
  const problems = prev.problems.filter((p) => !inAffected(p.file));
  const errorCount = problems.filter((p) => p.severity === "error").length;
  return {
    ...prev,
    problems,
    errorCount,
    warningCount: problems.length - errorCount,
    ok: errorCount === 0,
    diagnostics: prev.diagnostics.filter((d) => !names.has(d.project.toLowerCase())),
    modules: (prev.modules ?? []).filter((m) => !names.has(m.module.toLowerCase())),
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
