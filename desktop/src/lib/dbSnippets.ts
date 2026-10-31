/**
 * SQL 片段库：按连接或全局存几条常用的 SQL，本机 localStorage，不上传。
 *
 * 为什么不用后端存：片段是「我自己的备忘」，跨机器同步的需求远小于「随手存一条」的
 * 需求；放 localStorage 意味着断网、连不上库时也能翻。代价是换机器要自己带走（这种情况
 * 用「配置迁移」也不合适——片段里可能带上具体表名和客户数据，不该混进配置文件）。
 *
 * 作用域只有两种：`connId = null`（全局，所有连接都能看到）或某个连接（只在那里出现）。
 * 不做「工作区级」——数据库这一块没有工作区分组，多一层只会让人找不到自己刚存的片段。
 */

export interface Snippet {
  id: string;
  name: string;
  sql: string;
  /** `null` = 全局。 */
  connId: string | null;
  /** 最后修改时间（毫秒），列表按它倒序。 */
  at: number;
}

const KEY = "ncforge-db-snippets";
const MAX = 200;

/**
 * 读一次缓存：`useSyncExternalStore` 要求没变化时返回**同一个数组引用**，
 * 每次 `filter` 出新数组会让 React 无限重渲染。所以写入才换引用，读一律读缓存。
 */
let cache: Snippet[] | null = null;

function readAll(): Snippet[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    cache = Array.isArray(v) ? v.filter(isSnippet) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function isSnippet(v: unknown): v is Snippet {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<Snippet>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.sql === "string" &&
    (s.connId === null || typeof s.connId === "string") &&
    typeof s.at === "number"
  );
}

function writeAll(next: Snippet[]): void {
  cache = next;
  version++;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不下就算了：这条片段这次能用，下次打开就没了，但不该让编辑器报错
  }
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();

export function subscribeSnippets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const NONE: Snippet[] = [];

/** 每次写入 +1，用来判断快照是否过期。 */
let version = 0;
let snapKey = "";
let snapVal: Snippet[] = NONE;

/**
 * 稳定快照：`listSnippets` 每次都会 filter + sort 出新数组，直接喂给
 * `useSyncExternalStore` 会「每次都变了」→ 无限重渲染。这里按「连接 + 版本」缓存一份。
 */
export function snippetsSnapshot(connId: string | null): Snippet[] {
  const key = `${connId ?? ""}#${version}`;
  if (key !== snapKey) {
    snapVal = listSnippets(connId);
    snapKey = key;
  }
  return snapVal;
}

/**
 * 当前连接能看到的片段：该连接专属的在前，全局的在后，各自按修改时间倒序。
 * 「专属在前」是因为同一件事在两个库上的写法常常不同，越具体越可能是现在要的那条。
 */
export function listSnippets(connId: string | null): Snippet[] {
  const all = readAll();
  const mine = all.filter((s) => connId !== null && s.connId === connId).sort(byAt);
  const glob = all.filter((s) => s.connId === null).sort(byAt);
  if (mine.length === 0 && glob.length === 0) return NONE;
  return [...mine, ...glob];
}

const byAt = (a: Snippet, b: Snippet) => b.at - a.at;

function newId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 存一条。名字留空时用 SQL 第一行兜底，免得列表里出现一堆空标题。 */
export function addSnippet(input: { name: string; sql: string; connId: string | null }): Snippet {
  const name = input.name.trim() || defaultName(input.sql);
  const s: Snippet = { id: newId(), name, sql: input.sql, connId: input.connId, at: Date.now() };
  writeAll([s, ...readAll().filter((x) => x.id !== s.id)].slice(0, MAX));
  return s;
}

export function updateSnippet(id: string, patch: { name?: string; sql?: string; connId?: string | null }): void {
  const all = readAll();
  const i = all.findIndex((s) => s.id === id);
  if (i < 0) return;
  const old = all[i];
  const next: Snippet = {
    ...old,
    ...patch,
    name: (patch.name ?? old.name).trim() || defaultName(patch.sql ?? old.sql),
    at: Date.now(),
  };
  writeAll(all.map((s, k) => (k === i ? next : s)));
}

export function removeSnippet(id: string): void {
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length !== all.length) writeAll(next);
}

/** 片段搜索：名字或 SQL 命中都算，多个关键词要求全部命中（和历史的搜索口径一致）。 */
export function filterSnippets(list: Snippet[], query: string): Snippet[] {
  const words = splitWords(query);
  if (words.length === 0) return list;
  return list.filter((s) => {
    const hay = `${s.name}\n${s.sql}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 关键词切分（按空白），小写化。 */
export function splitWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** SQL 第一行前 40 字，去掉行注释符与多余空白。 */
export function defaultName(sql: string): string {
  const first = sql.split("\n").find((l) => l.trim() !== "") ?? "";
  const clean = first.replace(/^\s*(--|\/\/)\s*/, "").replace(/\s+/g, " ").trim();
  const s = clean.slice(0, 40) || "未命名片段";
  return clean.length > 40 ? `${s}…` : s;
}
