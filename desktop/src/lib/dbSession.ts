import { createSessionStore, useSessionStore } from "./sessionStore";

/**
 * 数据库页会话态（P2-9）：SQL 草稿 / 行数上限 / 超时。
 *
 * 「数据库页写 SQL → 文件页看代码 → 回来继续」是这个页面最核心的动线。
 * 此前三项都是 DbTab 的 useState，切页回来面对的是示例 SQL，写了一半的
 * 语句直接丢；maxRows / timeoutSec 是每次执行的重复设置，也不该每次重调。
 *
 * 连接态（useDbSession）不在这里：它跨页面共享且有后端真源，归 hook 管。
 */
export interface DbForm {
  sql: string;
  maxRows: number;
  timeoutSec: number;
}

/** 首访示例 SQL（原 DbTab.tsx 的 SAMPLE，搬来当仓库初始值）。 */
const SAMPLE = `select m.code, m.name, m.materialmny as 单价
from bd_material m
where m.code like 'CL04%'
order by m.code`;

export const dbSession = createSessionStore<DbForm>({
  sql: SAMPLE,
  maxRows: 500,
  timeoutSec: 30,
});

export const useDbForm = (): DbForm => useSessionStore(dbSession);
