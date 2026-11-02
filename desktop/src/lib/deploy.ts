import { invoke } from "./tauri";

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

export const deployPreview = () => invoke<DeployReport>("deploy_preview");
export const deployApply = () => invoke<DeployReport>("deploy_apply");
export const deployCleanup = () => invoke<CleanupReport>("deploy_cleanup");
export const deployStatus = () => invoke<DeployStatus>("deploy_status");
