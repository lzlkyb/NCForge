import { toast } from "../components/ui/toast";
import { friendlyDbError } from "./db";
import { dbApi, type ExportFileOut } from "./dbApi";
import { ensureConnected } from "./dbConfirm";
import { execOne, patchTab, sqlTabOf, type SqlTab } from "./dbStore";
import { orderBySql } from "./serverSort";

/**
 * 结果表上那两个「动数据」的动作：服务端重排（A3）与流式导出（A4）。
 *
 * **为什么单独一个文件而不是塞进 `dbActions`**：`dbActions` 引了 `sqlModels`
 * → `editorStore` → `monacoSetup`，等于把整个 Monaco 拉进任何引用它的组件与单测
 * （jsdom 里加载 Monaco 会直接报 `document.queryCommandSupported is not a function`）。
 * 结果区只需要这两个动作，不该为它们赔上 Monaco。
 */

/**
 * 用某一列在**数据库侧**重排并重查（A3）。
 *
 * 结果表默认排序只作用于已取到的行（`resultView.viewOrder`）——用户会以为整表有序。
 * 这个动作把 SQL 包一层 `order by` 重跑一次，结果区多一条结果，`sql` 也记成
 * 包装后的语句（复制出去就是真能跑的那条）。
 */
export async function reSortOnServer(
  tabId: string,
  sql: string,
  column: string,
  dir: "asc" | "desc",
): Promise<void> {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId || tab.running) return;
  const wrapped = orderBySql(sql, column, dir);
  if (!wrapped) {
    toast("只有单条 SELECT 能让数据库重排（DML / 多语句 / for update 不行）", "warning");
    return;
  }
  if (!(await ensureConnected(tab.connId))) return;
  patchTab<SqlTab>(tabId, { running: true });
  try {
    const entry = await execOne(tabId, wrapped, (sqlTabOf(tabId)?.results.length ?? 0) + 1);
    const cur = sqlTabOf(tabId);
    patchTab<SqlTab>(tabId, { results: [...(cur?.results ?? []), entry], view: entry.id });
  } finally {
    patchTab<SqlTab>(tabId, { running: false });
  }
}

/** 文件名里的时间戳：本机时区（后端没有 chrono，算 UTC 会让文件名差 8 小时）。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把整条查询的结果流式导出成文件（A4）。返回落盘信息（界面据此显示路径与「打开文件夹」）。
 *
 * 与工具栏那个「导出 INSERT」（`db_export_insert`）的分工：
 * - 那个带 NC 多语/主键规则，一次拼出整段文本，上限 10 万行；
 * - 这个只管把结果集打印成文件（CSV/TSV/INSERT），后端按页取、按行写，内存 O(一页)。
 */
export async function exportResultFile(
  tabId: string,
  sql: string,
  format: "csv" | "tsv" | "insert",
  table: string,
): Promise<ExportFileOut | null> {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId) return null;
  const base = table && table !== "表名" ? table : "result";
  try {
    const out = await dbApi.exportFile({
      id: tab.connId,
      sql,
      format,
      table: base,
      fileName: `${base}-${stamp()}.${format === "insert" ? "sql" : format}`,
      // 0 = 不限：导出要的是全量（后端仍有 200 万行硬上限，到了会标 truncated）
      maxRows: 0,
      timeoutSec: Math.max(tab.timeoutSec, 300),
    });
    toast(
      out.truncated
        ? `已导出 ${out.rows} 行（到了上限，文件不是全量）`
        : `已导出 ${out.rows} 行到 ${out.fileName}`,
      out.truncated ? "warning" : "success",
    );
    return out;
  } catch (e) {
    toast(`导出失败：${friendlyDbError(e)}`, "error");
    return null;
  }
}
