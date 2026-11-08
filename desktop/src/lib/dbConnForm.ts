import { buildOracleUrl, parseOracleUrl, type DbConn, type DbEngine, type DbEnv } from "./dbApi";

/**
 * 连接表单的可编辑字段（不含 `id` / `source` / `propDs` 这类跟着连接走的元信息）。
 *
 * 抽在 lib 里是为了让「主机 / 端口 / 服务名 ⇄ JDBC URL 双向同步」这条规则能单独测：
 * 它是表单里唯一有分支的逻辑，埋在 300 行的组件里没人敢动。
 */
export interface DbConnForm {
  name: string;
  env: DbEnv;
  host: string;
  port: string;
  service: string;
  sid: boolean;
  url: string;
  user: string;
  password: string;
  remember: boolean;
  autoCommit: boolean;
  note: string;
  engine: DbEngine;
  /** 默认 schema：连上就切过去，写 SQL 不用带 `aier633.` 前缀。空 = 登录账号自己的。 */
  defaultSchema: string;
}

export function initialConnForm(conn: DbConn | null): DbConnForm {
  const p = conn ? parseOracleUrl(conn.url) : null;
  return {
    name: conn?.name ?? "",
    env: conn?.env ?? "test",
    host: p?.host ?? "",
    port: p?.port ?? "1521",
    service: p?.service ?? "",
    sid: p?.sid ?? false,
    url: conn?.url ?? "",
    user: conn?.user ?? "",
    password: "",
    remember: true,
    autoCommit: conn?.autoCommit ?? false,
    note: conn?.note ?? "",
    engine: conn?.engine ?? "rust",
    defaultSchema: conn?.defaultSchema ?? "",
  };
}

/**
 * 改字段并按需同步连接串：
 * - 主机 / 端口 / 服务名 / SID 任一变 → 用这几项重拼 URL（主机或服务名为空就清空 URL，
 *   避免留下一条与字段对不上的旧串）；
 * - 直接改 URL → 反解出主机 / 端口 / 服务名（`parseOracleUrl` 认不出就只留 URL 文本）。
 *
 * 注意口令与「记住」也在同一个 patch 里流转：它们不参与同步，原样带过。
 */
export function mergeConnForm(f: DbConnForm, patch: Partial<DbConnForm>): DbConnForm {
  const next = { ...f, ...patch };
  if ("host" in patch || "port" in patch || "service" in patch || "sid" in patch) {
    next.url = next.host && next.service ? buildOracleUrl(next.host, next.port, next.service, next.sid) : "";
  } else if ("url" in patch) {
    const p = parseOracleUrl(next.url);
    if (p) Object.assign(next, { host: p.host, port: p.port, service: p.service, sid: p.sid });
  }
  return next;
}
