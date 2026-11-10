import { toast } from "../components/ui/toast";
import { friendlyDbError } from "./db";
import { dbApi, type ExportFileOut, type ExportProgress } from "./dbApi";
import { beginOperation, cancelOperation, getOperations } from "./operations";
import { dbTaskSpec } from "./dbOperations";
import { listen } from "./tauri";
import { ensureConnected } from "./dbConfirm";
import { connOf, execOne, isRunning, patchTab, rtOf, sqlTabOf, type RunToken, type SqlTab } from "./dbStore";
import { orderBySql } from "./serverSort";
import { resultTargetIssue, type ResultExecutionContext } from "./dbResultContext";

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
  context?: ResultExecutionContext,
): Promise<void> {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId || isRunning(tab)) return;
  const issue = context && resultTargetIssue(context, connOf(tab.connId), rtOf(tab.connId).currentSchema ?? rtOf(tab.connId).info?.schema);
  if (issue) { toast(issue, "warning"); return; }
  const wrapped = orderBySql(sql, column, dir);
  if (!wrapped) {
    toast("只有单条 SELECT 能让数据库重排（DML / 多语句 / for update 不行）", "warning");
    return;
  }
  if (!(await ensureConnected(tab.connId))) return;
  const task=beginOperation({...dbTaskSpec(`sort:${tabId}`,"数据库重排结果",tab.connId,tab.slot ? `独立会话 ${tab.slot}` : "主会话",undefined,tabId),cancel:()=>{const active=sqlTabOf(tabId);return active?.connId===tab.connId ? dbApi.cancel(tab.connId!,active.slot) : Promise.reject(new Error("来源标签已关闭或切换"));}});
  if(!task) return;
  const token: RunToken = { id: task.id, connId: tab.connId, at: Date.now(), slot: tab.slot ?? null, kind: "execute" };
  patchTab<SqlTab>(tabId, { run: token });
  try {
    const entry = await execOne(tabId, wrapped, (sqlTabOf(tabId)?.results.length ?? 0) + 1);
    task.finish(entry.cancelled ? "cancelled" : entry.kind==="error" ? "failed" : "success",entry.kind==="error" ? "重排未完成，返回结果页查看原因" : `已重新读取 ${entry.rows.length} 行${entry.hasMore ? "，仍有后续结果" : ""}`);
    const cur = sqlTabOf(tabId);
    patchTab<SqlTab>(tabId, { results: [...(cur?.results ?? []), entry], view: entry.id });
  } catch(error) {task.finish("failed","重排失败，返回数据库页查看原因");throw error;} finally {
    // 只清自己这一趟：期间用户可能已切连接或发起新执行
    if (sqlTabOf(tabId)?.run?.id === token.id) patchTab<SqlTab>(tabId, { run: undefined });
  }
}

/** 文件名里的时间戳：本机时区（后端没有 chrono，算 UTC 会让文件名差 8 小时）。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 正在进行的导出：结果标签 id → 这次导出的实例号。
 *
 * 同一条连接上可能同时开着几次导出（两个结果标签各导一份），后端只认识实例号，
 * 所以「取消」必须按标签找到自己那一次——用一个全局布尔会把别人的导出一起停掉。
 */
const activeExports = new Map<string, number>();
let exportSeq = 0;

/** 本次进程内单调递增，够用；不和时间戳拼，避免同毫秒撞号。 */
function nextExportId(): number {
  exportSeq += 1;
  return exportSeq;
}

/** 取消某个结果标签正在进行的导出；这个标签没有导出时什么也不做。 */
export function cancelResultExport(tabId: string): void {
  const id = activeExports.get(tabId);
  if (id === undefined) return;
  const task=getOperations().find(o=>o.key===`db.export:${tabId}` && o.endedAt===undefined);
  if(task) void cancelOperation(task.id);
}

/**
 * 这个标签当前导出的实例号（没有 = undefined）。
 *
 * 进度事件按实例号过滤：同一条连接上两个结果标签各自导出时，行数不能串到对方那儿去。
 */
export function activeExportId(tabId: string): number | undefined {
  return activeExports.get(tabId);
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
  const exportId = nextExportId();
  const task=beginOperation({...dbTaskSpec(`export:${tabId}`,"导出查询结果",tab.connId,`SQL 标签 ${tabId} · 独立导出会话`,undefined,tabId),phase:"读取查询并写入文件",cancel:()=>dbApi.cancelExport(exportId)});
  if(!task) return null;
  activeExports.set(tabId, exportId);
  let finished=false,un:(()=>void)|undefined;
  void listen<ExportProgress>("db:export-progress",p=>{if(!finished && p.id===tab.connId && p.exportId===exportId) task.update({phase:"读取查询并写入文件",progress:{done:p.rows}});}).then(f=>{if(finished) f();else un=f;}).catch(()=>undefined);
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
      exportId,
    });
    task.update({progress:{done:out.rows}});
    const lobCut = out.longValues ?? 0;
    task.finish(out.canceled ? "cancelled" : "success",`已写出 ${out.rows} 行${out.canceled ? "，已停止，文件保留已写内容" : out.truncated ? "，到达读取上限，文件不是全量" : "，文件已保存"}${lobCut > 0 ? `，${lobCut} 个长文本超过 1M 字符被截断` : ""}`);
    toast(
      out.canceled
        ? `已取消导出：文件里只有前 ${out.rows} 行`
        : out.truncated
          ? `已导出 ${out.rows} 行（到了上限，文件不是全量）`
          : lobCut > 0
            // 长文本被截断比行数不全更隐蔽：文件看起来"导完了"，实际 CLOB
            // 只有前 1M 个字符（还带一句中文提示），不能直接拿去迁移。
            ? `已导出 ${out.rows} 行，但有 ${lobCut} 个长文本超过 1M 字符，文件不是完整数据`
            : `已导出 ${out.rows} 行到 ${out.fileName}`,
      out.canceled || out.truncated || lobCut > 0 ? "warning" : "success",
    );
    return out;
  } catch (e) {
    task.finish("failed","导出失败，返回数据库页查看错误与已有文件");
    toast(`导出失败：${friendlyDbError(e)}`, "error");
    return null;
  } finally {
    finished=true;un?.();
    // 只清理自己那一次：用户可能已经在这个标签上开始了下一次导出
    if (activeExports.get(tabId) === exportId) activeExports.delete(tabId);
  }
}
