/**
 * 按需求审查：需求表的前端状态与命令封装（后端见 `commands/req_cmds.rs`）。
 *
 * 改动全集始终以 SVN 改动列表为准；这里只回答「改动文件属于哪些需求」。
 * 刷新时机：版本控制每次完整扫描成功后（顺带清掉已不在改动里的文件）、每次增删改需求后。
 * 不轮询：变更日志只在用户看版本控制时才有意义，而那里的扫描会顺带刷新它。
 */
import { invoke } from "./tauri";
import { createSessionStore, useSessionStore } from "./sessionStore";
import { getSession, useWorkspaceRoot } from "./workspaceSession";
import { onLocalSave } from "./localSaves";
import type { StatusResult } from "./svn";

export type ReqStatus = "open" | "closed";
export interface PackRecord { zip: string; atMs: number }
export interface Requirement {
  id: string;
  name: string;
  aliases: string[];
  status: ReqStatus;
  createdMs: number;
  packages: PackRecord[];
  /** 与更早的某个需求名很像时，建议合并到的需求 id。 */
  mergeHint: string | null;
}
export interface Touch {
  req: string | null;
  atMs: number;
  source: "ai" | "manual";
  op: string;
  tool?: string | null;
  client?: string | null;
  reason?: string | null;
  beforeSha?: string | null;
  afterSha?: string | null;
  backup?: string | null;
  seq: number;
}
export interface FileReqs { path: string; reqs: string[]; claimed: boolean; touches: Touch[] }
export interface JournalInfo { dir: string | null; found: boolean; lastAtMs: number; more: boolean }
export interface ReqView { reqs: Requirement[]; current: string | null; files: FileReqs[]; journal: JournalInfo }

export const EMPTY_REQ_VIEW: ReqView = Object.freeze({
  reqs: [], current: null, files: [],
  journal: { dir: null, found: false, lastAtMs: 0, more: false },
}) as ReqView;

interface ReqState { view: ReqView; loaded: boolean; error: string | null }
const stores = new Map<string, ReturnType<typeof createSessionStore<ReqState>>>();
const normRoot = (root: string | null | undefined) => (root ?? "").toLowerCase().replace(/\\/g, "/");
function storeOf(root: string | null | undefined) {
  const key = normRoot(root);
  let s = stores.get(key);
  if (!s) { s = createSessionStore<ReqState>({ view: EMPTY_REQ_VIEW, loaded: false, error: null }); stores.set(key, s); }
  return s;
}

/** 当前工作区的需求表（未加载时为空表）。 */
export function useRequirements(): ReqState {
  const root = useWorkspaceRoot();
  return useSessionStore(storeOf(root));
}
export const getRequirements = (): ReqState => storeOf(getSession().root).get();

/**
 * 把命令返回的视图写回**发起时的**工作区：参数里的 invoke 与这里取 root 在同一同步帧，
 * 中途切了工作区的结果不会串到新工作区。写操作失败把错误抛给调用方（界面要提示）；
 * 读操作（`read`）失败顺带记在状态里，给界面展示。
 *
 * 每个命令各写一次 `invoke("字面量")`，不要收成传命令名的帮助函数：命令契约脚本只认字面量。
 */
async function track(job: Promise<ReqView>, read = false): Promise<ReqView> {
  const s = storeOf(getSession().root);
  try {
    const view = await job;
    s.set({ view, loaded: true, error: null });
    return view;
  } catch (e) {
    if (read) s.set({ loaded: true, error: String(e) });
    throw e;
  }
}

let inflight: Promise<ReqView> | null = null;
/** 读需求表并同步变更日志。并发调用共用同一次请求。 */
export function refreshRequirements(): Promise<ReqView> {
  if (!getSession().root) return Promise.resolve(EMPTY_REQ_VIEW);
  inflight ??= track(invoke<ReqView>("req_state"), true).finally(() => { inflight = null; });
  return inflight;
}

export const reqCreate = (name: string) => track(invoke<ReqView>("req_create", { name }));
export const reqRename = (id: string, name: string) => track(invoke<ReqView>("req_rename", { id, name }));
export const reqMerge = (from: string, into: string) => track(invoke<ReqView>("req_merge", { from, into }));
export const reqSetStatus = (id: string, open: boolean) => track(invoke<ReqView>("req_set_status", { id, open }));
export const reqSetCurrent = (id: string | null) => track(invoke<ReqView>("req_set_current", { id }));
export const reqClaim = (paths: string[], id: string | null) => track(invoke<ReqView>("req_claim", { paths, id }));
export const reqRecordPackage = (id: string, zip: string) => track(invoke<ReqView>("req_record_package", { id, zip }));

let lastScan: StatusResult | undefined;
/**
 * 版本控制一次完整扫描成功后调用：先清掉已不在改动里的文件的归属，再同步变更日志。
 * 只接最终结果（`useQuery` 的 data 只在成功时更新），流式中途的半份数据绝不能传进来。
 */
export function syncRequirementsWithScan(status: StatusResult | undefined): void {
  if (!status || status === lastScan || !getSession().root) return;
  lastScan = status;
  const changed = status.changes.groups.flatMap((g) => g.items.map((it) => it.path));
  const job = changed.length
    ? track(invoke<ReqView>("req_prune", { changed }), true).then(() => refreshRequirements())
    : refreshRequirements();
  void job.catch(() => { /* 错误已记在状态里，界面按 error 展示 */ });
}

let started = false;
/** App 启动时调一次：在 NCForge 里手改保存的文件按「当前需求」记一条手改。 */
export function initRequirements(): void {
  if (started) return;
  started = true;
  onLocalSave((path) => {
    if (!getSession().root || path.includes("://")) return;
    // 工作区外的文件后端会拒绝；手改记录失败不打断保存，只是这次不归入当前需求。
    void track(invoke<ReqView>("req_note_manual", { path })).catch(() => {});
  });
}

/** 单测用。 */
export function resetRequirements(): void {
  stores.clear();
  inflight = null;
  lastScan = undefined;
  started = false;
}
