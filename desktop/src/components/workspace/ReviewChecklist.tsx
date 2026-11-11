import { useSyncExternalStore } from "react";
import { getCodeDiags, subscribeCodeDiags } from "../../lib/diagStore";
import { getSession, useWorkspaceSession } from "../../lib/workspaceSession";
import { getChangedRows, getSnapshotFor, subscribeSnapshot } from "../../lib/changedLinesStore";
import { problemsInChangedArea } from "../../lib/changedProblems";
import { checkChangedTables, tableRefsInChangedLines } from "../../lib/changedTables";
import { relativeDisplay } from "../../lib/reviewNotes";
import { openTimeline } from "../../lib/reviewSession";
import { useLangView } from "../../lib/lang";
import type { ChangeEvent } from "../../lib/changeTimeline";
import { toast } from "../ui/toast";

interface Item {
  /** info = 中性事实，既不算通过也不算警告，避免常态假绿 / 常态误报。 */
  tone: "bad" | "warn" | "ok" | "info";
  label: string;
  detail: string;
  line?: number;
  path?: string;
}

/**
 * D3 补丁审查清单。全部是「已有能力的汇总 + 领域规则」，不重造：
 * - 编译错误来自 ecj / jdt.ls 同一份快照，按**本轮文件范围**收集（P1-7）；
 * - 表结构核对复用 `tableLookup` 缓存；出包前的完整核对在补丁页 `TableCheck`；
 * - `.class` 配对 / SQL 只作为信息项，不再对 NC 常态场景误报 warn（P1-6）。
 *
 * 没有选中轮时不列任何「通过」项：原来的空态 5 项里 3 项显绿，容易被读成
 * 「检查通过」，实际什么都没查（P1-5）。
 */
export function ReviewChecklist({
  root, activePath, round, onOpenAt,
}: {
  root: string;
  activePath?: string | null;
  round: ChangeEvent | null;
  onOpenAt: (path: string, line: number, push?: boolean, column?: number) => void;
}) {
  const session = useWorkspaceSession();
  const snap = useSyncExternalStore(subscribeSnapshot, () => getSnapshotFor(activePath), () => getSnapshotFor(activePath));
  const diags = useSyncExternalStore(subscribeCodeDiags, getCodeDiags, getCodeDiags);
  const paths = round?.paths ?? [];
  const problems = problemsInChangedArea(
    activePath ?? "",
    paths,
    getSession().compileResult?.problems ?? [],
    diags,
    snap,
  );
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity !== "error");
  const inArea = problems.filter((p) => p.inChangedArea).length;

  // 表结构核对按**本轮全部文件**的变更行做：只看 activePath 时，用户切到别的文件
  // 打开清单就会得到「改动行里没有表引用」的假绿（`getChangedRows` 对没打开过的
  // 文件返回空数组，空数组不等于没有表引用）。
  const changedRows = paths.flatMap((p) => getChangedRows(p));
  const tables = checkChangedTables(tableRefsInChangedLines(changedRows));
  const missingTables = tables.filter((t) => t.exists === false);
  const noCache = tables.length > 0 && tables.every((t) => t.exists === null);

  const java = paths.filter((p) => p.toLowerCase().endsWith(".java"));
  const classes = paths.filter((p) => p.toLowerCase().endsWith(".class"));
  const sql = paths.filter((p) => p.toLowerCase().endsWith(".sql"));
  const scope = new Set(paths.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  const odd = session.tabs.filter((t) =>
    scope.has(t.path.replace(/\\/g, "/").toLowerCase())
    && (t.readOnlyReason === "lossy" || String(t.eol).toUpperCase() === "MIXED"));

  // 有没有「判定资本」：ecj 跑过一次（compileResult 在会话里）或语言服务就绪。
  // 两者都没有时 problems 必然是空数组——空数组不等于没有错误，写成绿色就是假绿。
  const lang = useLangView();
  const compiled = session.compileResult != null;
  const diagReady = lang.state === "ready";
  const judgeable = compiled || diagReady;

  const items: Item[] = [
    errors.length
      ? { tone: "bad", label: `本轮有 ${errors.length} 条编译错误`, detail: `${inArea} 条落在当前文件改动区 · ${errors.map((p) => `${relativeDisplay(p.path, root)}:${p.line} ${p.message}`).slice(0, 3).join("；")}`, line: errors[0].line, path: errors[0].path }
      : warnings.length
        ? { tone: "warn", label: `本轮有 ${warnings.length} 条警告`, detail: warnings.map((p) => `${relativeDisplay(p.path, root)}:${p.line}`).slice(0, 4).join("、"), line: warnings[0].line, path: warnings[0].path }
        : judgeable
          ? { tone: "ok", label: "本轮文件没有编译错误", detail: `ecj 与语言服务的诊断已按 ${paths.length} 个文件核对` }
          : { tone: "info", label: "还没编译过，语言服务也未就绪", detail: "现在没有可核对的诊断，不代表没有错误：在文件页编译一次，或等语言服务就绪后再看这份清单" },
    missingTables.length
      ? { tone: "bad", label: `${missingTables.length} 个表名在库里查不到`, detail: missingTables.map((t) => `第 ${t.line} 行 · ${t.name}`).join("；"), line: missingTables[0].line, path: activePath ?? undefined }
      : noCache
        ? { tone: "warn", label: `${tables.length} 个表名待核对`, detail: "没有表结构缓存：连上数据库或到补丁页同步一次" }
        : tables.length
          ? { tone: "ok", label: "改动行引用的表都能在库里找到", detail: `${tables.length} 处引用已核对` }
          : changedRows.length
            ? { tone: "ok", label: "改动行引用的表都能在库里找到", detail: "改动行里没有表引用" }
            : { tone: "info", label: "本轮还没有变更行可核对表结构", detail: "基线未建立或文件还没打开过：打开本轮文件后再看这份清单" },
    { tone: odd.length ? "warn" : "ok", label: odd.length ? `${odd.length} 个文件编码/换行异常` : "编码与换行正常", detail: odd.length ? odd.map((t) => relativeDisplay(t.path, root)).slice(0, 3).join("；") : "GBK / 混合换行已按原字节处理" },
    { tone: "info", label: `.java / .class ${java.length} : ${classes.length}`, detail: "源码补丁可不打包产物；产物补丁请先编译并在补丁页勾选" },
    { tone: "info", label: sql.length ? `本轮含 ${sql.length} 个 SQL 文件` : "本轮没有 SQL 文件", detail: "涉及表结构变更时记得一并打包" },
  ];

  const openPatch = () => {
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "patch" }));
    toast("已切到补丁页：出包前的表结构核对与环境检查在那里", "info");
  };

  if (!round) {
    return (
      <div className="ncf-check">
        <div className="ncf-check-hd"><span>出包前审查清单</span></div>
        <div className="ncf-empty">
          先在「改动时间线」里选中一轮，清单才会按这一轮的文件范围与改动区生成。
          不按轮出清单会把整个会话打开过的文件混在一起，结论没有意义。
          <div><button type="button" className="ncf-link" onClick={openTimeline}>去选一轮 →</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="ncf-check">
      <div className="ncf-check-hd">
        <span>出包前审查清单 · 本轮 {paths.length} 个文件 · {round.label ?? "改动轮"}</span>
        <button type="button" className="ncf-link" onClick={openPatch}>打开补丁页核对 →</button>
      </div>
      <div className="ncf-check-list">
        {items.map((it, i) => (
          <div key={i} className="ncf-check-item" data-tone={it.tone}>
            <span className="ncf-check-dot" aria-hidden="true" />
            <span className="ncf-check-label">{it.label}</span>
            <span className="ncf-check-detail" title={it.detail}>{it.detail}</span>
            {it.line && it.path && (
              <button type="button" className="ncf-link" onClick={() => onOpenAt(it.path!, it.line!)}>定位</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
