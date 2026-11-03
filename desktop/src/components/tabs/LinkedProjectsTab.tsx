import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import "../../linked.css";
import { DockRegion } from "../workspace/WorkbenchDock";
import { ProjectChain } from "../linked/ProjectChain";
import { ArtifactCheck } from "../linked/ArtifactCheck";
import { artifactMarks } from "../linked/artifactKind";
import { OverrideEditor } from "../linked/OverrideEditor";
import { WorkspaceSwitch } from "../linked/WorkspaceSwitch";
import { Icon } from "../ui/icon";
import { FreshnessBadge } from "../ui/FreshnessBadge";
import { Skeleton } from "../ui/Skeleton";
import { toast } from "../ui/toast";
import { useLinkedGraph } from "../../hooks/useLinkedGraph";
import { useOverrideDraft } from "../../hooks/useOverrideDraft";
import { useArtifactCheck } from "../../hooks/useArtifactCheck";
import {
  overrideHits,
  removeOverride,
  upsertOverride,
  type LinkedProject,
  type OverrideAction,
} from "../../lib/linkedProjects";
import { applyWorkspace } from "../../lib/switchWorkspace";
import { collectUnsaved, saveAllDirty } from "../../lib/saveAllDirty";

/**
 * 「工程关联」页：多工程依赖链 + 覆盖表 + 切换工作区。
 *
 * 这是后端 `eclipse_cp::{graph,active_overrides}` 的界面。数据只有两个来源：
 * `linked_projects`（依赖链，只读事实）与配置里的 `linked_overrides`（我们的旋钮）。
 * 覆盖表**不改任何工程文件**，只决定工作台自己怎么算类路径——编译 / 启动 / 影子工程 /
 * 语言服务四处共用同一份结果。
 *
 * 拆件口径（门禁要求单文件 ≤300 行 / ≤8 个 hooks）：
 * - 依赖链只读视图 → `linked/ProjectChain`
 * - 覆盖表草稿编辑 → `linked/OverrideEditor`
 * - 切换工作区与预演 → `linked/WorkspaceSwitch`
 * 本文件只做取数、整表保存与切换编排。
 */
export function LinkedProjectsTab() {
  const queryClient = useQueryClient();
  const { graph, error, loading, at, reload } = useLinkedGraph();
  const ov = useOverrideDraft();
  const [busy, setBusy] = useState(false);

  /**
   * 产物检查的状态（8~22 秒的整树扫描，见 `check_artifacts`）。
   *
   * 签名 = **每个工程名 + 它贡献的类目录数 + 是否停用**。
   * 只比工程名是不够的：停用一个工程时它仍然留在 `projects` 里（只是 `disabled`、
   * 目录数变 0），名字序列一模一样，但**检查范围已经变了**——拿旧结论给用户看
   * 就是「明明停用了 newar，它还在报 newar 的产物旧」。同理，追加/删除目录也改变
   * 扫描范围。这三样一起才足以判断「这条结论还成不成立」。
   */
  const chainStamp = graph
    ? graph.projects
        .map((p) => `${p.name}:${p.classDirs.length}${p.disabled ? "!" : ""}`)
        .join(">")
    : "";
  const chk = useArtifactCheck(chainStamp, graph?.primaryRoot ?? null);
  /** 检查读的是**已落盘**的覆盖表，草稿没保存就点会得到对不上的结论 */
  const checkBlocked = !graph
    ? "还没读到依赖链，先点「重新读取」"
    : ov.dirty
      ? "覆盖表有未保存的改动：检查用的是已落盘的配置，先保存再检查"
      : null;

  /** 行内按钮：只改草稿。命中判定与后端一致（工程名 / 绝对路径 / 目录名三路）。 */
  const toggle = (action: OverrideAction, p: LinkedProject) => {
    const existing = ov.draft.find((o) => o.action === action && overrideHits(o, p));
    ov.setDraft(
      existing
        ? removeOverride(ov.draft, existing)
        : upsertOverride(ov.draft, { action, target: p.name }),
    );
  };

  const save = async () => {
    // 配置没读到就保存 = 用空白草稿把用户手写的覆盖全清掉。宁可拦住。
    if (!ov.loaded || ov.error) {
      toast("覆盖表还没读成功，先重试读取再保存（否则会用空白草稿覆盖现有配置）", "error");
      return;
    }
    try {
      const stored = await ov.save(ov.draft);
      toast(`覆盖表已保存（${stored.length} 条）`, "success");
      // 目录数与顺序都可能变，必须重读依赖链；不重读的话界面还停在旧顺序上
      await reload();
    } catch (e) {
      toast(`保存覆盖表失败：${e}`, "error");
    }
  };

  /**
   * 切换工作区。
   *
   * 顺序是「先保存磁盘文件，再切」：`applyWorkspace` 会关掉所有编辑器模型，
   * 没落盘的改动会直接消失。任何一个文件保存失败就整体中止并说清是哪个文件——
   * 冲突时替用户决定覆盖是最糟的失败形态。
   */
  const switchTo = async (path: string): Promise<boolean> => {
    setBusy(true);
    try {
      if (collectUnsaved().length > 0) {
        const r = await saveAllDirty();
        if (r.failed.length > 0) {
          const first = r.failed[0];
          toast(
            `有 ${r.failed.length} 个文件保存失败（${first.name}：${first.reason}），已取消切换`,
            "error",
          );
          return false;
        }
      }
      const shown = await applyWorkspace(path, queryClient);
      await reload();
      // 覆盖表本身不随工作区变，但仍以服务端为准重读一次：手改过配置文件时界面才对得上
      await ov.load();
      toast(`已切换到 ${shown}`, "success");
      return true;
    } catch (e) {
      toast(`切换工作区失败：${e}`, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <DockRegion region="document">
      <div className="lnk-page">
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
            onRefresh={() => void reload()}
          />
          <button
            type="button"
            className="lnk-btn"
            disabled={loading}
            onClick={() => void reload()}
            title="重新读盘解析（改过 .classpath 或覆盖表之后）"
          >
            <Icon name="refresh" size={12} />
            {loading ? "读取中…" : "重新读取"}
          </button>
        </header>

        <WorkspaceSwitch
          current={graph?.primaryRoot ?? ""}
          busy={busy}
          unsavedCount={collectUnsaved().length}
          onSwitch={switchTo}
        />

        {error && (
          <div className="lnk-error">
            <Icon name="alertTriangle" size={14} />
            <span>{error}</span>
          </div>
        )}

        {!graph && loading && <Skeleton className="h-40" />}

        {graph && (
          <ProjectChain
            graph={graph}
            overrides={ov.draft}
            artifacts={artifactMarks(chk.result)}
            onToggle={toggle}
          />
        )}

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

        {ov.error && (
          <div className="lnk-error">
            <Icon name="alertTriangle" size={14} />
            <span>读取覆盖表失败：{ov.error}（此时保存会用空白草稿覆盖现有配置，已拦住）</span>
            <button type="button" className="lnk-btn" onClick={() => void ov.load()}>
              重试
            </button>
          </div>
        )}

        <OverrideEditor
          draft={ov.draft}
          dirty={ov.dirty}
          saving={ov.saving}
          onChange={ov.setDraft}
          onSave={() => void save()}
          onReset={() => ov.setDraft(ov.saved)}
        />
      </div>
    </DockRegion>
  );
}
