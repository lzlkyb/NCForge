import { invoke } from "./tauri";
import { trackOperation } from "./operations";
import { getSession } from "./workspaceSession";

/**
 * 工程元数据投送（Rust `nchome_deploy`）。
 *
 * NC 按文件路径读 `<NCHOME>/modules/<模块>/META-INF/` 下的 upm/rest，
 * 不按 classpath。改了工程里的 upm 必须落地到 NCHOME，运行时才会读到。
 */

export interface DeployAction {
  module: string;
  file: string;
  target: string;
  source: string;
  backup: string | null;
}

export interface DeployConflict {
  target: string;
  winner: string;
  loser: string;
}

export interface DeployReport {
  home: string;
  projectRoots: string[];
  comboChanged: boolean;
  previousCombo: string[];
  planned: number;
  created: DeployAction[];
  updated: DeployAction[];
  /** 内容已一致、只登记接管（清理时不删） */
  adopted: DeployAction[];
  unchanged: number;
  conflicts: DeployConflict[];
  skipped: string[];
  applied: boolean;
  backupRoot: string;
  manifestPath: string;
}

export interface CleanupReport {
  home: string;
  manifestPath: string;
  deleted: string[];
  restored: string[];
  skipped: string[];
}

export interface DeployStatus {
  home: string;
  manifestPath: string;
  hasManifest: boolean;
  combo: string[];
  files: number;
  written: number;
  backups: number;
  updatedMs: number;
}

export const deployPreview = () => trackOperation({ key: `deploy.preview:${getSession().root}`, label: "预览元数据投送", scope: getSession().root ?? "工作区", page: "services", phase: "检查目标文件与工程顺序" }, () => invoke<DeployReport>("deploy_preview"), deployOutcome);
export const deployApply = () => trackOperation({ key: `deploy.apply:${getSession().root}`, label: "投送元数据", scope: getSession().root ?? "工作区", page: "services", phase: "备份并写入 NC home" }, () => invoke<DeployReport>("deploy_apply"), deployOutcome);
export const deployCleanup = () => trackOperation({ key: `deploy.cleanup:${getSession().root}`, label: "清理已投送元数据", page: "services", phase: "还原备份与清理受管文件" }, () => invoke<CleanupReport>("deploy_cleanup"), r => ({ state: "success", detail: `删除 ${r.deleted.length} 个、还原 ${r.restored.length} 个、跳过 ${r.skipped.length} 个；详见投送报告` }));
function deployOutcome(r: DeployReport) {
  return { state: "success" as const, detail: `${r.applied ? "已投送" : "预览"}：新增 ${r.created.length} 个、更新 ${r.updated.length} 个；跳过 ${r.skipped.length} 个，${r.conflicts.length} 个冲突按工程顺序取首个；详见投送报告` };
}
export const deployStatus = () => invoke<DeployStatus>("deploy_status");
