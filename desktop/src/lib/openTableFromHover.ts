import { dbSchemaStatus } from "./db";
import { getDb, connOf, loadConns, openTableTab } from "./dbStore";
import { ensureConnected } from "./dbConfirm";
import { toast } from "../components/ui/toast";

/**
 * 悬停卡片里点「在数据库中打开」。
 *
 * 用哪个连接：**表结构缓存属于谁就用谁**（`db_schema_status` 回的 `connId`）。
 * 理由很直接——悬停卡片里显示的就是那个库的字段，打开同一张表当然去同一个库；
 * 换成「最近用过的连接」会在多库之间摇摆，看一眼表就跑错库。
 *
 * 没连上时自动连（用户明确选了这条路）：有存口令就静默连，需要口令才弹框。
 * 唯一的例外是**没有连接可用**——那种情况切到数据库页并提示先建一个，
 * 而不是凭空造连接。
 *
 * 页面切换走 `ncforge-navigate` 事件（App 已有监听），不在这里直接改 tab 状态：
 * 数据库页是懒加载的，切过去才挂载，而 `openTableTab` 写的是模块级 store，
 * 挂载时自己就渲染出来了。
 */
export async function openTableInDb(table: string): Promise<void> {
  // 1. 找出表结构缓存对应的连接。读不到状态就当成"没有缓存"处理。
  let connId: string | null = null;
  try {
    connId = (await dbSchemaStatus()).connId;
  } catch {
    connId = null;
  }

  if (!getDb().loaded) await loadConns();
  // 缓存里记的连接可能已经被删了（配置改过），当成没有
  if (connId && !connOf(connId)) connId = null;

  // 2. 先切到数据库页：连库可能要几秒、还可能要输口令，让人看着进度
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "db" }));

  if (!connId) {
    toast("还没有数据库连接：先在数据库页连一个库，再回来打开表", "error");
    return;
  }

  // 3. 没连上就自动连；需要口令时 `ensureConnected` 会弹全局口令框，取消返回 false
  if (!(await ensureConnected(connId))) return;

  openTableTab(connId, table, "data");
}
