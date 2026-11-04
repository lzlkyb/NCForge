import { invoke, listen } from "./tauri";
import { trackOperation } from "./operations";
import { getSession } from "./workspaceSession";
import { withSvnWriteLock, type SvnWriteHandle } from "./svnWrite";

/**
 * 版本控制（SVN）的命令封装与纯函数。
 *
 * 后端错误统一编码成 `code|message`（见 `commands/svn_cmds.rs`）：
 * `auth` 要弹登录框、`conflict` 指向冲突处理、其余原样显示。
 */

export interface SvnInfo {
  root: string;
  url: string;
  revision: number;
  host: string;
  user: string | null;
  hasPassword: boolean;
  /** `saved`（工作台自己存的）/ `svn-cache`（复用 Eclipse 的）/ `none`。 */
  credentialSource: string;
  bridgeAlive: boolean;
}

export type StatusLetter = "M" | "A" | "D" | "?" | "C" | "!" | "R" | "G" | "~";

export interface ChangeItem {
  path: string;
  rel: string;
  module: string;
  letter: StatusLetter;
  status: string;
  revision: number;
  isDir: boolean;
  /** 构建产物 / 冲突残留：列表默认隐藏，由界面开关决定显不显示（不在后端过滤）。 */
  ignored: boolean;
  /** 本地文件修改时间（毫秒 epoch）；读不到为 null（删除、缺失、权限）。 */
  mtimeMs?: number | null;
}

export interface ChangeGroup {
  module: string;
  items: ChangeItem[];
}

export interface ChangesView {
  groups: ChangeGroup[];
  shown: number;
  total: number;
  /** 被忽略规则挡掉的条数（构建产物、冲突残留）。 */
  ignored: number;
}

export interface StatusResult {
  changes: ChangesView;
  scanned: number;
  generatedAtMs: number;
  hasConflict: boolean;
  /** 仍然有效的已审标记（key = 小写 + 正斜杠的绝对路径）。 */
  reviewed: string[];
}

export interface DiffResult {
  baseText: string;
  workingText: string;
  encoding: string;
  eol: string;
  baseEmpty: boolean;
  baseSize: number;
  workingSize: number;
  editable: boolean;
}

export interface LogEntry {
  revision: number;
  author: string;
  date: number;
  message: string;
}

export interface BlameLine {
  revision: number;
  author: string;
  date: number;
}

export interface CommitResult {
  revision: number;
  author: string;
  added: string[];
}

export interface UpdateResult {
  revision: number;
}

export interface ResolveResult {
  /** 冲突临时文件（.mine / .rN）的备份目录；没有可备份的文件时为 null。 */
  backupDir: string | null;
}

export interface RevertResult {
  count: number;
  backupDir: string;
}

/** 撤销 / 冲突二选一留下的备份目录（工作副本旁边的 `.ncforge-<kind>-<毫秒>`）。 */
export interface BackupDir {
  name: string;
  path: string;
  kind: "revert" | "resolve";
  files: number;
  bytes: number;
  /** 目录名里的时间戳（毫秒）。 */
  atMs: number;
}

export interface HousekeepingInfo {
  /** 备份目录所在的目录（工作副本上一级）。 */
  baseDir: string;
  backups: BackupDir[];
  totalBytes: number;
  reviewTotal: number;
  reviewValid: number;
  reviewStale: number;
}

export interface PurgeFailure {
  name: string;
  message: string;
}

export interface BackupPurgeResult {
  deleted: number;
  bytes: number;
  /** 逐个删时失败的条目：`deleted` 只统计成功的那些。 */
  failed: PurgeFailure[];
}

export const svnInfo = () => invoke<SvnInfo>("svn_info");
/**
 * 扫描改动。一次返回全部条目（构建产物带 `ignored` 标记），
 * 界面的「显示全部」开关只在本地过滤，不再重扫。
 */
export const svnStatus = () => invoke<StatusResult>("svn_status");
export const svnDiff = (path: string) => trackOperation({ key: `svn.diff:${path.toLowerCase()}`, label: "读取 SVN 差异", scope: path, page: "svn", path }, () => invoke<DiffResult>("svn_diff", { path }));
export const svnLog = (path: string, limit: number, from: number) =>
  trackOperation({ key: `svn.log:${path.toLowerCase()}:${from}`, label: "读取 SVN 历史", scope: path || "工作副本", page: "svn" }, () => invoke<LogEntry[]>("svn_log", { path, limit, from }));
export const svnBlame = (path: string) => trackOperation({ key: `svn.blame:${path.toLowerCase()}`, label: "读取逐行追溯", scope: path, page: "svn", path }, () => invoke<BlameLine[]>("svn_blame", { path }));
export const svnCommit = (paths: string[], message: string, guard?: SvnWriteHandle) => {
  const root = getSession().root ?? "";
  const snapshot = { paths: [...paths], message };
  return withSvnWriteLock(root, "commit", () => guard
    ? invoke<CommitResult>("svn_commit", { ...snapshot, expectedRoot: root })
    : trackOperation({ key: `svn.commit:${root}`, label: "提交 SVN 改动", scope: root, page: "svn", phase: "提交选中文件，等待服务器确认" }, () => invoke<CommitResult>("svn_commit", { ...snapshot, expectedRoot: root }), r => ({ state: "success", detail: `服务器已确认提交 r${r.revision}` })), guard);
};
export const svnUpdate = (guard?: SvnWriteHandle) => {
  const root = getSession().root ?? "";
  return withSvnWriteLock(root, "update", () => trackOperation({ key: `svn.update:${root}`, label: "更新 SVN 工作副本", scope: root, page: "svn", phase: "更新文件，等待服务器返回" }, () => invoke<UpdateResult>("svn_update", { expectedRoot: root }), r => ({ state: "success", detail: `已更新到 r${r.revision}；冲突由后续扫描确认` })), guard);
};
export const svnRevert = (paths: string[], recursive: boolean, guard?: SvnWriteHandle) => {
  const root = getSession().root ?? "";
  const snapshot = [...paths];
  return withSvnWriteLock(root, "revert", () => trackOperation({ key: `svn.revert:${root}`, label: "撤销 SVN 本地改动", page: "svn", phase: "备份后恢复 BASE" }, () => invoke<RevertResult>("svn_revert", { paths: snapshot, recursive, expectedRoot: root }), r => ({ state: "success", detail: `已撤销 ${r.count} 个；备份位于 ${r.backupDir}` })), guard);
};
export const svnResolve = (path: string, choice: "mine" | "theirs" | "base", guard?: SvnWriteHandle) => {
  const root = getSession().root ?? "";
  return withSvnWriteLock(root, "resolve", () => trackOperation({ key: `svn.resolve:${root}:${path}`, label: "解决 SVN 冲突", scope: path, page: "svn", phase: "备份冲突文件并应用所选版本" }, () => invoke<ResolveResult>("svn_resolve", { path, choice, expectedRoot: root })), guard);
};
export const svnReviewMark = (path: string, revision: number, reviewed: boolean) =>
  invoke<void>("svn_review_mark", { path, revision, reviewed });
export const svnReviewPrune = () => trackOperation({ key: "svn.review.prune", label: "清理失效审查标记", page: "svn" }, () => invoke<number>("svn_review_prune"));
/** 维护面板的只读数据：备份目录盘点 + 审查标记统计。 */
export const svnHousekeeping = () => trackOperation({ key: `svn.housekeeping:${getSession().root}`, label: "盘点 SVN 备份", page: "svn" }, () => invoke<HousekeepingInfo>("svn_housekeeping"));
/** 按**目录名**删备份（后端校验名字与父目录，前端不传路径）。 */
export const svnBackupDelete = (names: string[]) =>
  trackOperation({ key: `svn.backup.purge:${getSession().root}`, label: "清理 SVN 备份", page: "svn" }, () => invoke<BackupPurgeResult>("svn_backup_delete", { names }), r => ({ state: r.failed.length ? "failed" : "success", detail: `删除 ${r.deleted} 个；${r.failed.length} 个未删除，详见维护面板` }));
export const svnAuthSet = (user: string, password: string) =>
  trackOperation({ key: "svn.auth", label: "验证 SVN 账号", errorDetail: () => "账号验证失败，请查看账号对话框", page: "svn", phase: "连接服务器验证并保存凭据" }, () => invoke<void>("svn_auth_set", { user, password }));

/**
 * 扫描进度（桥每 300 条推一次）。
 *
 * 一次全量 status 要 7.6 秒，界面上只有一个转圈的图标时用户分不清「在跑」和「卡死」。
 * 进度只是提示，丢了不影响结果，所以订阅失败也不必处理。
 */
export const onSvnScanProgress = (handler: (scanned: number) => void) =>
  listen<{ scanned: number }>("svn-scan-progress", (p) => handler(p.scanned));

// ───────────────────────── 纯函数 ─────────────────────────

const KNOWN_CODES = new Set(["auth", "conflict", "wc", "timeout", "spawn", "other"]);

/**
 * 拆后端错误。约定：`code|message`，只认已知 code 前缀；
 * 不认识的（普通字符串错误）整体当消息，code 记 `other`。
 */
export function parseSvnError(e: unknown): { code: string; message: string } {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const idx = text.indexOf("|");
  if (idx > 0) {
    const code = text.slice(0, idx);
    if (KNOWN_CODES.has(code)) {
      return { code, message: text.slice(idx + 1) };
    }
  }
  return { code: "other", message: text };
}

/** 与后端 `svn_review::key_of` 一致：小写 + 正斜杠，Windows 路径大小写不敏感。 */
export function keyOf(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 状态字母 → 语义色调（样式表按 data-st 上色）。 */
export function letterTone(letter: string): "mod" | "add" | "del" | "conflict" | "untracked" {
  switch (letter) {
    case "M":
    case "R":
      return "mod";
    case "A":
      return "add";
    case "D":
    case "!":
      return "del";
    case "C":
      return "conflict";
    default:
      return "untracked";
  }
}

/**
 * 这个条目能不能标「已审」。
 *
 * 三种不能：目录（没有文件内容）、冲突 C（要先解决才有内容可审）、已删除/缺失 D、!
 * （文件已经不在盘上，后端取 metadata 必然失败）。它们也确实没有入口——
 * 分母里算上它们，进度永远到不了 100%，用户没法判断是真没审完还是分母算错。
 */
export function isMarkable(it: ChangeItem): boolean {
  return !it.isDir && it.letter !== "C" && it.letter !== "D" && it.letter !== "!";
}

/**
 * 审查进度：只算「能标记已审」的文件（见 `isMarkable`）。
 * 未纳管的文件也要审——提交前同样得看。
 */
export function reviewProgress(
  view: ChangesView,
  reviewed: Set<string>,
): { done: number; total: number; percent: number } {
  let total = 0;
  let done = 0;
  for (const g of view.groups) {
    for (const it of g.items) {
      if (!isMarkable(it)) continue;
      total += 1;
      if (reviewed.has(keyOf(it.path))) done += 1;
    }
  }
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** 把后端给的已审 key 列表变成 Set。 */
export function reviewedSet(status: StatusResult | undefined): Set<string> {
  return new Set(status?.reviewed ?? []);
}

export type SortMode = "path" | "mtime";

/**
 * 排序：`path` 原样返回（后端已按路径排好），`mtime` 组内新的在上、
 * 模块组按「组内最新时间」降序。**纯本地**——切排序不能再扫一次后端（7.6 秒）。
 *
 * 取不到 `mtimeMs`（删除、缺失、权限）当 0 处理，与「很旧」一起排到最后，
 * 同刻的按路径兜底，保证顺序稳定。
 */
export function sortChanges(groups: ChangeGroup[], mode: SortMode): ChangeGroup[] {
  if (mode === "path") return groups;
  const at = (it: ChangeItem) => it.mtimeMs ?? 0;
  const newest = (g: ChangeGroup) => g.items.reduce((m, it) => Math.max(m, at(it)), 0);
  const out = groups.map((g) => ({
    module: g.module,
    items: [...g.items].sort((a, b) => at(b) - at(a) || a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
  }));
  out.sort((a, b) => newest(b) - newest(a) || a.module.localeCompare(b.module));
  return out;
}

/**
 * 列表里的修改时间：5 分钟内「刚刚」、当天 `HH:mm`、昨天「昨天」、
 * 7 天内「N 天前」、更早 `MM-DD`（跨年带年份）。读不到给 `—`。
 *
 * 当天给时刻而不是「N 小时前」：`09:05` 比 `5 小时前`更能直接回答"什么时候改的"。
 * `now` 可注入：时钟偏差与「刚刚」的边界都得靠它单测。
 */
export function formatWhen(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = (t: number) => {
    const x = new Date(t);
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  const diff = now - ms;
  // 时钟偏差（系统时间被改、文件来自未来）不显示「N 小时前」这种负数
  if (diff < 0) return day(now) === day(ms) ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (diff < 5 * 60_000) return "刚刚";
  if (day(now) === day(ms)) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (day(now - 86_400_000) === day(ms)) return "昨天";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(now).getFullYear() === d.getFullYear()
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${String(d.getFullYear()).slice(2)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `2026-10-19 17:15` 这种短格式；时间戳单位是毫秒。 */
export function formatRevTime(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 提交说明首行（列表里只显示一行）。 */
export function firstLine(message: string): string {
  const line = message.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

/** 文件大小差：`1.2 KB`。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 目录没被纳管时后端会报 wc 错误，界面上要能说人话。 */
export function friendlySvnError(e: unknown): string {
  const { code, message } = parseSvnError(e);
  switch (code) {
    case "auth":
      return "需要 SVN 账号密码：点右上角「账号」输一次，之后会记住";
    case "conflict":
      return message.includes("冲突") ? message : `有冲突未解决：${message}`;
    case "wc":
      return "这个路径不在 SVN 版本控制下（可能是新目录或工作副本外）";
    case "timeout":
      return "SVN 响应太慢，已中断。服务器不通或工作副本被别的程序锁着";
    case "spawn":
      return message;
    default:
      return message;
  }
}
