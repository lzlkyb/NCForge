import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import "../../md.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { DockRegion } from "../workspace/WorkbenchDock";
import { MdScopeBar } from "./MdScopeBar";
import { MdTablePicker } from "./MdTablePicker";
import { MdDictResult } from "./MdDictResult";
import { useDbSelector } from "../../lib/dbStore";
import { beginOperation, trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { getDb, connOf } from "../../lib/dbStore";
import { patchDictTab } from "../../lib/dbStore";
import { dbPanelId, dbTabId } from "../../lib/dbPendingSessions";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import { loadPatchDraft } from "../../lib/patchDraft";
import {
  MAX_TABLES,
  mdDict,
  mdErrorText,
  mdTables,
  scopeEmpty,
  scopeFilter,
  scopeLabel,
  sqlTables,
  type PickRow,
  type Scope,
  type ScopeKind,
} from "../../lib/mdDict";

/** 左栏一次列多少张。再多也翻不动，缩关键词更快。 */
const PICK_LIMIT = 200;

/**
 * 数据字典文档（数据库页的一种标签）。
 *
 * 为什么是文档而不是按钮弹出的对话框：读回来的东西是**文档**（表 → 列 → 中文名 →
 * 实体属性），要能停在屏幕上对照着写代码、贴进设计文档；弹框一关就没了，
 * 也挡不住后面的 SQL 结果。
 *
 * 侧栏放选表器、文档区放范围头与结果——两者都是往工作台停靠区 portal，
 * 所以这里自己渲染两个 DockRegion；数据库页在字典标签激活时让出侧栏。
 * 状态（选表过程 + 生成结果）存在 `dbStore` 的字典标签里：切到 SQL 标签看一行、
 * 再切回来，字典还在。
 */
export function DictWorkspace({ tabId }: { tabId: string }) {
  const root = useWorkspaceRoot();
  // 只订阅自己这个标签：别的标签跑查询不重画字典页
  const tab = useDbSelector((s) => s.tabs.find((t) => t.id === tabId));
  const st = tab?.kind === "dict" ? tab.state : null;
  const connId = tab?.kind === "dict" ? tab.connId : null;

  const kw = (st?.keyword ?? "").trim();
  const searching = st?.mode === "picked" && kw.length > 0;

  const tablesQ = useQuery({
    queryKey: ["md-tables", connId, kw],
    queryFn: () => mdTables({ names: [], prefix: "", keyword: kw }, PICK_LIMIT, connId),
    enabled: searching,
    retry: false,
  });

  const rows = useMemo<PickRow[]>(() => {
    if (!st || st.mode === "prefix") return [];
    if (st.mode === "patch") {
      const p = st.patch;
      if (!p) return [];
      const all: PickRow[] = [
        ...p.rows,
        ...p.missing.map((n) => ({ name: n, displayName: "", isExtend: false, module: "", missing: true })),
      ];
      if (!kw) return all;
      const k = kw.toLowerCase();
      return all.filter((r) => r.name.toLowerCase().includes(k) || r.displayName.toLowerCase().includes(k));
    }
    return tablesQ.data?.tables ?? [];
  }, [st, kw, tablesQ.data]);

  if (!tab || !st) return null;

  const selected = new Set(st.picked.map((n) => n.toLowerCase()));

  const scope: Scope =
    st.mode === "prefix"
      ? { kind: "prefix", prefix: st.prefix }
      : { kind: st.mode, names: st.picked };

  const canRun = !scopeEmpty(scope) && !st.running;

  // 判断放在函数式更新里读仓库里的最新集合：用外层闭包的 `selected` 时，
  // 连点两下（中间没重新渲染）会拿旧集合判断，第二次点击就删错了。
  const toggle = (name: string) =>
    patchDictTab(tab.id, (s) => {
      const has = s.picked.some((n) => n.toLowerCase() === name.toLowerCase());
      return {
        picked: has ? s.picked.filter((n) => n.toLowerCase() !== name.toLowerCase()) : [...s.picked, name],
      };
    });

  /** 切到「补丁涉及」：扫草稿 → 核对库里有哪些 → 补齐中文名与缺失名单。 */
  const scanPatch = async () => {
    const task=beginOperation(dbTaskSpec(`dict.scan:${tab.id}`,"核对补丁涉及的数据库表",tab.connId,"NC 字典",connOf(tab.connId)?.name,tab.id));
    if(!task) return;
    const found = sqlTables(loadPatchDraft(root)?.sqls ?? []);
    const capped = found.slice(0, MAX_TABLES);
    if (found.length > MAX_TABLES) {
      toast(`补丁草稿的 SQL 提到 ${found.length} 张表，超过上限，只取了前 ${MAX_TABLES} 张`, "error");
    }
    patchDictTab(tab.id, { mode: "patch", error:null, keyword: "", picked: capped.map((t) => t.name), patch: null });
    if (capped.length === 0) {
      patchDictTab(tab.id, { patch: { rows: [], missing: [] } });
      task.finish("success","补丁草稿未涉及数据库表");return;
    }
    try {
      // 多要一次查询是为了拿到中文名，并提前分辨「草稿里写了、库里没有」的表——
      // 等到生成完才说，用户已经按缺表的名字写好文档了。
      const out = await mdTables(
        { names: capped.map((t) => t.name), prefix: "", keyword: "" },
        MAX_TABLES,
        tab.connId,
      );
      const current=getDb().tabs.find(t=>t.id===tab.id);
      if(current?.kind!=="dict" || current.state.mode!=="patch") {task.finish("cancelled","来源标签或范围已切换");return;}
      task.finish("success",`已核对 ${capped.length} 张表，找到 ${out.tables.length} 张`);
      const have = new Set(out.tables.map((t) => t.name.toLowerCase()));
      patchDictTab(tab.id, {
        patch: {
          rows: out.tables,
          missing: capped.map((t) => t.name).filter((n) => !have.has(n.toLowerCase())),
        },
      });
    } catch (e) {
      task.finish("failed","补丁表核对失败，返回字典页查看原因");
      toast(mdErrorText(e), "error");
      patchDictTab(tab.id, { patch: { rows: [], missing: [] },error:`补丁表核对失败：${mdErrorText(e)}` });
    }
  };

  const onMode = (k: ScopeKind) => {
    if(st.running) return;
    if (k === "patch") {
      void scanPatch();
      return;
    }
    patchDictTab(tab.id, { mode: k });
  };

  const run = async () => {
    if(!canRun) return;
    patchDictTab(tab.id, { running: true, error: null });
    try {
      const data = await trackOperation(dbTaskSpec(`dict:${tab.id}`,"生成 NC 数据字典",tab.connId,"NC 字典",connOf(tab.connId)?.name,tab.id),()=>mdDict(scopeFilter(scope), tab.connId),d=>({state:d.missing.length ? "failed" : "success",detail:`已读取 ${d.tableCount} 张表、${d.columnCount} 列${d.missing.length ? `，${d.missing.length} 张表未找到` : ""}${d.columnsWithoutName ? `，${d.columnsWithoutName} 列缺少中文名` : ""}`}));
      patchDictTab(tab.id, { data, running: false });
    } catch (e) {
      patchDictTab(tab.id, { error: mdErrorText(e), running: false });
    }
  };

  const patchScanned = st.patch === null ? null : st.patch.rows.length + st.patch.missing.length;

  const hint =
    st.mode === "prefix"
      ? st.prefix.trim()
        ? `前缀 ${st.prefix.trim()} · 一次最多 ${MAX_TABLES} 张`
        : "填一个表名前缀，如 bd_"
      : st.mode === "patch"
        ? st.patch === null
          ? "正在扫补丁草稿…"
          : st.picked.length === 0
            ? "补丁草稿里没有可用的表"
            : `扫出 ${st.picked.length} 张表`
        : scopeLabel(scope);

  return (
    <>
      <DockRegion region="sidebar">
        {st.mode === "prefix" ? (
          <div className="md-pick">
            <div className="md-fill" style={{ paddingTop: 28 }}>
              <Icon name="sliders" size={20} />
              <p>
                <b>按前缀取表</b>
              </p>
              <p>不用逐张勾选。填好前缀点「生成字典」，结果抬头会告诉你一共多少张、多少列。</p>
              <p>超过 500 张会直接报错——那是为了让你把前缀写细，而不是悄悄截断半份字典。</p>
            </div>
          </div>
        ) : (
          <MdTablePicker
            rows={rows}
            selected={selected}
            keyword={st.keyword}
            onKeyword={(v) => patchDictTab(tab.id, { keyword: v })}
            onToggle={toggle}
            onAll={() =>
              patchDictTab(tab.id, { picked: rows.filter((r) => !r.missing).map((r) => r.name) })
            }
            onNone={() => patchDictTab(tab.id, { picked: [] })}
            busy={st.mode === "patch" ? st.patch === null : searching && tablesQ.isFetching}
            error={st.mode === "picked" && tablesQ.isError ? mdErrorText(tablesQ.error) : st.mode==="patch" ? st.error : null}
            truncated={st.mode === "picked" && (tablesQ.data?.truncated ?? false)}
            emptyTitle={
              st.mode === "patch"
                ? st.patch === null
                  ? "正在核对库里的表…"
                  : "补丁草稿里没有扫到表"
                : !kw
                  ? "输入表名或中文名开始找表"
                  : "没有匹配的表"
            }
            emptyHint={
              st.mode === "patch"
                ? "去版本控制页的「打包补丁」把这次要发的 SQL 挂上，再回到这里"
                : !kw
                  ? "只输两个字也能搜（会同时匹配表名与中文名）。找不到就用「前缀」模式按 bd_ 这种前缀浏览。"
                  : "换个说法试试；表名可以用片段，如 mat 能搜到 bd_material"
            }
          />
        )}
      </DockRegion>

      <DockRegion region="document">
        <div className="md-page" role="tabpanel" id={dbPanelId(tab.id)} aria-labelledby={dbTabId(tab.id)}>
          <MdScopeBar
            mode={st.mode}
            onMode={onMode}
            pickedCount={st.picked.length}
            patchScanned={patchScanned}
            hint={hint}
            canRun={canRun}
            running={st.running}
            onRun={() => void run()}
          />

          {st.mode === "prefix" && (
            <div className="md-prefix-row">
              <input
                value={st.prefix}
                onChange={(e) => patchDictTab(tab.id, { prefix: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && canRun) void run();
                }}
                placeholder="bd_"
                spellCheck={false}
                autoFocus
                aria-label="表名前缀"
              />
              <span className="md-hint">按字面前缀比较：`_` 和 `%` 都是普通字符，不是通配符</span>
            </div>
          )}

          <div className="md-res">
            <MdDictResult tabId={tab.id} connId={tab.connId} data={st.data} running={st.running} error={st.error} />
          </div>
        </div>
      </DockRegion>
    </>
  );
}
