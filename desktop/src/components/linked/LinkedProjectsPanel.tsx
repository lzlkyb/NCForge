import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import "../../linked.css";
import { ProjectChain } from "./ProjectChain";
import { ArtifactCheck } from "./ArtifactCheck";
import { UpmCheck } from "./UpmCheck";
import { artifactMarks } from "./artifactKind";
import { OverrideEditor } from "./OverrideEditor";
import { Icon } from "../ui/icon";
import { FreshnessBadge } from "../ui/FreshnessBadge";
import { Skeleton } from "../ui/Skeleton";
import { toast } from "../ui/toast";
import { useLinkedGraph } from "../../hooks/useLinkedGraph";
import { useOverrideDraft } from "../../hooks/useOverrideDraft";
import { useArtifactCheck } from "../../hooks/useArtifactCheck";
import { useUpmCheck } from "../../hooks/useUpmCheck";
import {
  overrideHits,
  removeOverride,
  upsertOverride,
  type LinkedProject,
  type OverrideAction,
} from "../../lib/linkedProjects";
import type { LinkedSection } from "../../lib/linkedDialog";

/**
 * 「工程关联」弹框的内容体。
 *
 * 三块内容放在同一列而不是分页：覆盖表里「停用 pm」会改变依赖链，产物检查的
 * 结论又要回标到链的每一行——分页会把这种对应关系藏起来。弹框只是个观看窗口，
 * 数据来源仍是 `linked_projects`（只读事实）与配置里的 `linked_overrides`（我们的旋钮）。
 *
 * 与拆件前的页面相比只少了「切换工作区」：代码页树头已经能换目录（含未保存拦截
 * 与最近目录），这里再放一份是第二个入口。切目录前的依赖链预演暂未迁移。
 *
 * `save` 通过 ref 暴露给弹框：关闭时若有未保存草稿，确认框需要「保存并关闭」。
 */

export interface LinkedProjectsPanelHandle {
  save(): Promise<boolean>;
}

const SECTIONS: { key: LinkedSection; label: string }[] = [
  { key: "chain", label: "依赖链" },
  { key: "overrides", label: "覆盖规则" },
  { key: "artifacts", label: "产物检查" },
];

export const LinkedProjectsPanel = forwardRef<
  LinkedProjectsPanelHandle,
  {
    /** 打开时直接滚到哪一块（问题面板跳进来时不是从顶部看起）。 */
    section: LinkedSection;
    /** 弹框是否开着：关着（退场动画期间仍挂载）时不读盘。 */
    active: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    /** 弹框的关闭入口。Esc / 遮罩同样走它，未保存时由弹框拦一道。 */
    onClose?: () => void;
  }
>(function LinkedProjectsPanel({ section, active, onDirtyChange, onClose }, ref) {
  const { graph, error, loading, at, reload } = useLinkedGraph(active);
  const ov = useOverrideDraft();
  const {
    draft,
    saved,
    loaded,
    saving,
    error: ovError,
    dirty,
    setDraft,
    save: saveOverrides,
    load: loadOverrides,
  } = ov;

  /**
   * 产物检查的状态（8~22 秒的整树扫描，见 `check_artifacts`）。
   *
   * 签名 = 每个工程名 + 它贡献的类目录数 + 是否停用。只比工程名不够：停用一个工程时
   * 它仍在 `projects` 里（只是 `disabled`、目录数变 0），名字序列一模一样，但检查范围
   * 已经变了；追加/删除目录同理。三样一起才足以判断「这条结论还成不成立」。
   */
  const chainStamp = graph
    ? graph.projects
        .map((p) => `${p.name}:${p.classDirs.length}${p.disabled ? "!" : ""}`)
        .join(">")
    : "";
  const chk = useArtifactCheck(chainStamp, graph?.primaryRoot ?? null);
  // 装配表的结论挂在**主工程根**上：切了工作区（primaryRoot 变）就不再成立
  const upm = useUpmCheck(graph?.primaryRoot ?? "", graph?.primaryRoot ?? null);
  /** 检查读的是**已落盘**的覆盖表，草稿没保存就点会得到对不上的结论 */
  const checkBlocked = !graph
    ? "还没读到依赖链，先点「重新读取」"
    : dirty
      ? "覆盖表有未保存的改动：检查用的是已落盘的配置，先保存再检查"
      : null;

  const bodyRef = useRef<HTMLDivElement>(null);
  const chainRef = useRef<HTMLDivElement>(null);
  const overridesRef = useRef<HTMLDivElement>(null);
  const artifactsRef = useRef<HTMLDivElement>(null);

  const jump = useCallback((target: LinkedSection) => {
    const node =
      target === "chain" ? chainRef.current : target === "overrides" ? overridesRef.current : artifactsRef.current;
    const body = bodyRef.current;
    if (!node || !body) return;
    // jsdom 没有实现 scrollTo；少这一层判断测试里整个挂载都会抛错
    body.scrollTo?.({ top: Math.max(0, node.offsetTop - 8), behavior: "smooth" });
    node.classList.add("lnk-flash");
    window.setTimeout(() => node.classList.remove("lnk-flash"), 1600);
  }, []);

  // 从问题面板进来时直接落到对应区块；依赖链/产物检查要等图读到再滚，
  // 否则滚的是一个空占位。重新打开（active 翻转）也要回到请求的区块，
  // 不能停在用户上次滚到的位置；重新读取不抢滚动位置。
  const hasGraph = graph !== null;
  useEffect(() => {
    if (!active) return;
    if (hasGraph || section === "overrides") jump(section);
  }, [active, section, hasGraph, jump]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** 保存草稿并重读依赖链；返回是否成功，弹框据此决定要不要关。 */
  const save = useCallback(async (): Promise<boolean> => {
    if (!loaded || ovError) {
      toast("覆盖表还没读成功，先重试读取再保存（否则会用空白草稿覆盖现有配置）", "error");
      return false;
    }
    try {
      const stored = await saveOverrides(draft);
      toast(`覆盖表已保存（${stored.length} 条）`, "success");
      await reload(true);
      return true;
    } catch (e) {
      toast(`保存覆盖表失败：${e}`, "error");
      return false;
    }
  }, [loaded, ovError, saveOverrides, draft, reload]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  /** 行内按钮：只改草稿。命中判定与后端一致（工程名 / 绝对路径 / 目录名三路）。 */
  const toggle = (action: OverrideAction, p: LinkedProject) => {
    const existing = draft.find((o) => o.action === action && overrideHits(o, p));
    setDraft(existing ? removeOverride(draft, existing) : upsertOverride(draft, { action, target: p.name }));
  };

  return (
    <div className="lnk-panel">
      <header className="lnk-head">
        <h2>工程关联</h2>
        <span className="lnk-hint">
          {graph
            ? `主工程 ${graph.primary} · ${graph.projects.length} 个工程`
            : "从各工程的 .classpath 解析依赖闭包"}
        </span>
        <span className="lnk-sp" />
        <FreshnessBadge
          state={loading ? "loading" : error ? "error" : "live"}
          at={at}
          label="依赖链"
          staleAfterMs={300_000}
          onRefresh={() => void reload(true)}
        />
        <button
          type="button"
          className="lnk-btn"
          disabled={loading}
          onClick={() => void reload(true)}
          title="重新读盘解析（改过 .classpath 或覆盖表之后）"
        >
          <Icon name="refresh" size={12} />
          {loading ? "读取中…" : "重新读取"}
        </button>
        {onClose && (
          <button type="button" className="lnk-ibtn" title="关闭（Esc）" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        )}
      </header>

      <nav className="lnk-jump" aria-label="跳到区块">
        {SECTIONS.map((s) => (
          <button key={s.key} type="button" className="lnk-jump-btn" onClick={() => jump(s.key)}>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="lnk-body" ref={bodyRef}>
        {error && (
          <div className="lnk-error">
            <Icon name="alertTriangle" size={14} />
            <span>{error}</span>
            <button type="button" className="lnk-btn" onClick={() => void reload(true)}>
              重试
            </button>
          </div>
        )}

        {!graph && loading && <Skeleton className="h-40" />}

        <div className="lnk-anchor" ref={chainRef}>
          {graph && (
            <ProjectChain
              graph={graph}
              overrides={draft}
              artifacts={artifactMarks(chk.result)}
              onToggle={toggle}
            />
          )}
        </div>

        <div className="lnk-anchor" ref={overridesRef}>
          {ovError && (
            <div className="lnk-error">
              <Icon name="alertTriangle" size={14} />
              <span>读取覆盖表失败：{ovError}（此时保存会用空白草稿覆盖现有配置，已拦住）</span>
              <button type="button" className="lnk-btn" onClick={() => void loadOverrides()}>
                重试
              </button>
            </div>
          )}
          <OverrideEditor
            draft={draft}
            dirty={dirty}
            saving={saving}
            onChange={setDraft}
            onSave={() => void save()}
            onReset={() => setDraft(saved)}
          />
        </div>

        <div className="lnk-anchor" ref={artifactsRef}>
          {graph && (
            <ArtifactCheck
              running={chk.running}
              error={chk.error}
              result={chk.result}
              stale={chk.stale}
              elapsedMs={chk.elapsedMs}
              disabledReason={checkBlocked}
              onRun={() => void chk.run()}
            />
          )}
        </div>

        {/* 不加 `lnk-anchor`：那是给左侧区块跳转用的锚点，导航里没有「UPM 装配」这一项，
            多一个锚点会让「跳转到第 N 块」的定位错位 */}
        <div>
          {graph && (
            <UpmCheck
              running={upm.running}
              deep={upm.deep}
              error={upm.error}
              report={upm.report}
              stale={upm.stale}
              elapsedMs={upm.elapsedMs}
              onRun={(opts) => void upm.run(opts)}
            />
          )}
        </div>
      </div>
    </div>
  );
});
