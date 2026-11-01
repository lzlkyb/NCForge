import { invoke } from "./tauri";

/**
 * 本地历史（Local History）：写盘前自动归档，可在右侧面板里看旧版、恢复旧版。
 *
 * 与 Rust `local_history.rs` / `local_history_cmds.rs` 一一对应（camelCase）。
 * 存的是**原字节**（不做编码 / 换行转换），所以 GBK、混合换行、带 BOM 的文件
 * 都能原样进、原样出；预览时才用 `decode_lossy` 解文本。
 */

/** 一个历史版本。列表最新在前。 */
export interface HistoryVersion {
  /** `{归档时间ms}-{内容哈希前8位}`，同时是后端 blob 文件名。 */
  id: string;
  /** 归档时间（Unix 毫秒）。 */
  ts: number;
  /** 那一版的字节数。 */
  size: number;
  /** 内容 SHA-256（hex）。 */
  sha: string;
}

/** 一个历史版本的预览内容。 */
export interface VersionPreview {
  size: number;
  /** 解码后的文本。超大版本为 `null`（这时只展示大小）。 */
  text: string | null;
  /** 文本是否因过大被截断（当前实现是整份不给，见后端 `MAX_PREVIEW_BYTES`）。 */
  truncated: boolean;
  /** 归档时间（Unix ms），与列表里的 `ts` 一致。 */
  ts: number;
}

/** 归档一个文件的当前磁盘内容。内容没变返回 `null`（没生成新版本）。 */
export const captureLocalHistory = (path: string) =>
  invoke<string | null>("local_history_capture", { path });

/** 列出一个文件的历史版本（最新在前）。 */
export const listLocalHistory = (path: string) =>
  invoke<HistoryVersion[]>("local_history_list", { path });

/** 读一个历史版本用于预览 / 差异对比。 */
export const readLocalHistory = (path: string, id: string) =>
  invoke<VersionPreview>("local_history_read", { path, id });

/**
 * 恢复一个历史版本（把那时的字节写回文件）。
 *
 * `expectedMtimeMs`：前端读文件时记下的 mtime；磁盘被别的途径改过就报 CONFLICT，
 * 不覆盖。恢复前后端会先把当前内容归档一版——恢复也是一次改动，得能再退回来。
 */
export const restoreLocalHistory = (path: string, id: string, expectedMtimeMs?: number) =>
  invoke<void>("local_history_restore", { path, id, expectedMtimeMs });

/**
 * 静默归档：给「保存前 / 切文件前 / 兜底轮询」用的封装。
 *
 * 失败**绝不能**影响用户操作——历史是保险丝，不是主流程。所以这里吞掉一切
 * （磁盘满、目录被删、文件正在被占用都只当没发生），只留一行 console 供排查。
 */
export const captureQuietly = (path: string): void => {
  if (!path) return;
  void captureLocalHistory(path).catch((e) => {
    console.warn("[local-history] capture failed:", path, e);
  });
};
