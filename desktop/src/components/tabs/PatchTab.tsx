import { useMemo, useState } from "react";
import "../../patch.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { PatchList } from "../patch/PatchList";
import { StageTree } from "../patch/StageTree";
import { ItemDetail } from "../patch/ItemDetail";
import { ChangesMd } from "../patch/PatchChangesMd";
import { PatchActions } from "../patch/PatchActions";
import { BuildBanner } from "../patch/BuildBanner";
import { TableCheck } from "../patch/TableCheck";
import { usePatchScan } from "../../hooks/usePatchScan";
import { usePatchBuild } from "../../hooks/usePatchBuild";
import { useCheckGuard } from "../../hooks/useCheckGuard";
import { baseName, buildStageTree } from "../../lib/patchTree";
import {
  forceOf,
  selectablePaths,
  type FilterKey,
  type PatchItem,
} from "../../lib/patch";
import { keyOf } from "../../lib/svn";

/**
 * 补丁打包页。
 *
 * 布局照 design/NCForge-补丁与数据库-设计稿-2026-10-28.html 与
 * design/NCForge-表名核对-设计稿-2026-10-28.html：
 * 左清单（打什么）／右落位预览、CHANGES.md 或表结构核对／底部一次成包。
 *
 * 清单来自「未提交的 SVN 改动」，落位规则**全在后端**（`patch_view.rs` 是
 * `build-nc-patch.sh` 的逐条落地），表名核对也在后端（`sql_refs.rs`）。
 * 这个文件只做布局、勾选与调后端。
 */
export function PatchTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  /** 手动改判层：path → hyext / 标准层。层判错的唯一自救手段（见 ItemDetail）。 */
  const [layers, setLayers] = useState<Map<string, "hy" | "std">>(new Map());
  const force = useMemo(() => forceOf(layers), [layers]);
  const { defaults, changes, candidates, deleted, scan, refresh } = usePatchScan(force);
  const build = usePatchBuild(defaults.data?.outDir ?? null, force);

  // null = 「跟着扫描结果走，默认全勾可打的」。用户一动就变成显式集合，
  // 这样重扫后新增的文件不会把他手动取消的勾又勾回来。
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"stage" | "md" | "check">("stage");

  // 扫描结果本身是 react-query 的引用稳定值，但 `?? []` 每次渲染都是新数组——
  // 不包一层 useMemo，下面两个依赖 items 的 useMemo 每拍都会重算、并触发 hooks 规则告警。
  const items: PatchItem[] = useMemo(() => scan.data?.items ?? [], [scan.data]);
  /**
   * 勾选集。`picked` 为 null 时跟着扫描结果走（默认全勾可打的）。
   *
   * 重扫后某一项可能从「可打」变成 blocked（class 过期、文件被删）：必须在这里
   * 把它剔出去。只靠复选框 disabled 不够——它早就被勾上了，禁用之后用户点不动、
   * 取消不掉，出包必然失败，唯一复位途径是切到别的页再回来。
   */
  const pickedSet = useMemo(() => {
    const base = new Set(picked ?? selectablePaths(items));
    for (const it of items) if (it.blocked) base.delete(it.path);
    return base;
  }, [picked, items]);

  /** 改判某一层的判定（再点一次 = 回到自动）。 */
  const setLayer = (path: string, next: "hy" | "std" | null) => {
    setLayers((prev) => {
      const m = new Map(prev);
      if (next === null) m.delete(path);
      else m.set(path, next);
      return m;
    });
  };

  /**
   * 绝对路径 → SVN 字母。扫描 DTO 里没有这个字段（它不属于补丁规则）。
   * 键必须走 `keyOf` 归一化：candidates 的 path 是 Java `File.getPath()` 原样
   * （Windows 反斜杠），而 PatchItem.path 已被 Rust `pv::norm` 改成正斜杠。
   */
  const letters = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of candidates) m.set(keyOf(c.path), c.letter);
    return m;
  }, [candidates]);

  const chosen = useMemo(() => items.filter((it) => pickedSet.has(it.path)), [items, pickedSet]);
  // 勾选指纹（路径拼串）一变，核对结果与二次确认态整台重置——state 机在 hook 里
  const { setCheck, armed, setArmed, tablesMissing } = useCheckGuard(
    chosen.map((c) => c.path).join("|"),
  );
  const tree = useMemo(() => buildStageTree(chosen, build.sqls), [chosen, build.sqls]);
  const current = items.find((it) => it.path === selected) ?? null;

  // 只在「显示值还是后端原样给的」时候标注来源；用户一改，来源就变成 config，不用再解释
  const origin = useMemo(() => {
    const d = defaults.data;
    if (!d || d.outDir !== build.dir) return null;
    return { source: d.outDirSource, exists: d.outDirExists };
  }, [defaults.data, build.dir]);

  const toggle = (path: string) => {
    const next = new Set(pickedSet);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setPicked(next);
  };
  const toggleGroup = (paths: string[], on: boolean) => {
    const next = new Set(pickedSet);
    for (const p of paths) {
      if (on) next.add(p);
      else next.delete(p);
    }
    setPicked(next);
  };

  const err = scan.error ?? changes.error ?? null;
  const dirty = build.desc.trim().length > 0;

  const buildNow = () => {
    if (tablesMissing > 0 && !armed) {
      setArmed(true);
      toast(`有 ${tablesMissing} 张表在库里找不到，再点一次仍然生成`, "warning");
      return;
    }
    setArmed(false);
    void build.doBuild(chosen.map((c) => c.path));
  };

  return (
    <div className="pk-page">
      <div className="pk-head">
        <h1>补丁打包</h1>
        <span className="pk-kv">
          产物根 <b>{scan.data?.outRoots.join("、") || "未探测"}</b>
        </span>
        <span className="pk-kv pk-kv--dir" title={build.dir || "还没选输出目录"}>
          输出到 <b>{build.dir ? baseName(build.dir) : "未设置"}</b>
        </span>
        <span className="pk-sp" />
        <button type="button" className="pk-btn" disabled={scan.isFetching} onClick={refresh}>
          <Icon name="refresh" size={13} className={scan.isFetching ? "animate-spin" : undefined} />
          {scan.isFetching ? "扫描中…" : "重扫改动"}
        </button>
        <button
          type="button"
          className="pk-btn pk-btn-primary"
          data-armed={armed || undefined}
          disabled={build.building || chosen.length === 0 || !dirty || !build.dir}
          title={
            !dirty
              ? "先写一句改动内容描述（它就是包名）"
              : !build.dir
                ? "还没选补丁输出目录"
                : tablesMissing > 0
                  ? `${tablesMissing} 张表在库里找不到（见「表结构核对」），点两次才出包`
                  : `生成 ${build.zipName}`
          }
          onClick={buildNow}
        >
          <Icon name="package" size={13} />
          {build.building ? "出包中…" : armed ? `仍然生成（${tablesMissing} 表不存在）` : "生成补丁包"}
        </button>
      </div>

      {err && (
        <div className="pk-banner" data-tone="bad">
          <Icon name="alert" size={13} />
          <span>{String(err)}</span>
        </div>
      )}
      {scan.data && scan.data.problems.length > 0 && (
        <div className="pk-banner" data-tone="warn">
          <Icon name="alertTriangle" size={13} />
          <span>{scan.data.problems.map((p) => p.text).join("；")}</span>
        </div>
      )}
      {build.result && <BuildBanner result={build.result} />}

      <div className="pk-split">
        <PatchList
          items={items}
          deleted={deleted}
          letters={letters}
          scanning={scan.isFetching}
          picked={pickedSet}
          keyword={keyword}
          filter={filter}
          selected={selected}
          onKeyword={setKeyword}
          onFilter={setFilter}
          onToggle={toggle}
          onToggleGroup={toggleGroup}
          onSelect={setSelected}
        />

        <div className="pk-right">
          <div className="pk-tabs">
            <button type="button" className="pk-tab" data-on={tab === "stage" || undefined} onClick={() => setTab("stage")}>
              <Icon name="package" size={13} />
              落位预览
            </button>
            <button type="button" className="pk-tab" data-on={tab === "md" || undefined} onClick={() => setTab("md")}>
              <Icon name="file" size={13} />
              CHANGES.md
            </button>
            <button
              type="button"
              className="pk-tab"
              data-on={tab === "check" || undefined}
              onClick={() => setTab("check")}
            >
              <Icon name="database" size={13} />
              表结构核对
              {tablesMissing > 0 && (
                <span className="pk-pill" data-tone="bad">
                  {tablesMissing} 表
                </span>
              )}
            </button>
            <span className="pk-sp" />
            <label className="pk-desc">
              改动描述
              <input
                value={build.desc}
                placeholder="如：库存借出借入跨组织改造"
                spellCheck={false}
                onChange={(e) => build.setDesc(e.target.value)}
              />
            </label>
            <span className="pk-zipname" title={build.zipName}>
              {build.zipName}
            </span>
          </div>

          {tab === "stage" ? (
            <div className="pk-stage">
              <StageTree
                nodes={tree}
                hint={
                  chosen.length === 0
                    ? "左侧勾选要进补丁的文件，这里会显示最终的 zip 目录树"
                    : "正在读取落位…"
                }
              />
              {current ? (
                <ItemDetail
                  item={current}
                  override={layers.get(current.path) ?? null}
                  onForce={(v) => setLayer(current.path, v)}
                />
              ) : (
                <div className="pk-detail pk-detail-empty">
                  <Icon name="info" size={12} />
                  点左侧文件名看它的模块、产物与落位依据
                </div>
              )}
            </div>
          ) : tab === "md" ? (
            <ChangesMd
              draft={build.draft}
              onChange={(f, v) => build.setDraft((d) => ({ ...d, [f]: v }))}
              items={chosen}
              sqls={build.sqls}
            />
          ) : (
            <TableCheck files={chosen.map((c) => c.path)} onResult={setCheck} onNavigate={onNavigate} />
          )}
        </div>
      </div>

      <PatchActions
        dir={build.dir}
        origin={origin}
        onSaveDir={build.saveOutDir}
        sqls={build.sqls}
        onSqls={build.setSqls}
        blockedCount={scan.data?.blockedCount ?? 0}
        deletedCount={deleted.length}
        building={build.building}
        count={chosen.length}
        canBuild={chosen.length > 0 && dirty && !!build.dir}
        // 底部这颗也要走 buildNow：以前它直接 doBuild，把「表不存在」的二次确认
        // 整个绕过去了——顶部按钮点第一次只是变成确认态，底部一次就出包。
        onBuild={buildNow}
      />
    </div>
  );
}
