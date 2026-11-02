import { Button } from "../ui/button";
import type { ScopeKind } from "../../lib/mdDict";

/**
 * 数据字典顶栏：三种选表方式 + 生成。
 *
 * 三个 chip 是**互斥**的（不是三个开关）。后端 `TableFilter` 允许 names / prefix
 * 同时给并取交集，但那种组合在界面上无法解释——勾了 20 张、又填了 `bd_`、只出 5 张时，
 * 用户没有任何线索能想明白为什么。所以这里一次只亮一个，切换即替换。
 */
export function MdScopeBar({
  mode,
  onMode,
  pickedCount,
  patchScanned,
  hint,
  canRun,
  running,
  onRun,
}: {
  mode: ScopeKind;
  onMode: (k: ScopeKind) => void;
  /** 已勾选的表数。 */
  pickedCount: number;
  /** 从补丁草稿扫到的表数；`null` = 还没扫过（不显示数字，避免显示 0 被当成「没有」）。 */
  patchScanned: number | null;
  /** 范围摘要 / 前置条件，如「还没连库」。 */
  hint: string;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="md-head">
      <h1>数据字典</h1>
      <div className="md-scope" role="group" aria-label="选表方式">
        <button
          type="button"
          className="md-chip"
          data-on={(mode === "picked") || undefined}
          aria-pressed={mode === "picked"}
          onClick={() => onMode("picked")}
        >
          勾选表
          {pickedCount > 0 && <span className="md-chip-num">{pickedCount}</span>}
        </button>
        <button
          type="button"
          className="md-chip"
          data-on={(mode === "prefix") || undefined}
          aria-pressed={mode === "prefix"}
          onClick={() => onMode("prefix")}
        >
          前缀
        </button>
        <button
          type="button"
          className="md-chip"
          data-on={(mode === "patch") || undefined}
          aria-pressed={mode === "patch"}
          onClick={() => onMode("patch")}
          title="从补丁草稿里挂的 SQL 扫出涉及的表"
        >
          补丁涉及
          {patchScanned !== null && <span className="md-chip-num">{patchScanned}</span>}
        </button>
      </div>
      <span className="md-hint" title={hint}>
        {hint}
      </span>
      <span className="md-sp" />
      <Button size="sm" onClick={onRun} disabled={!canRun} isLoading={running} loadingText="生成中…">
        生成字典
      </Button>
    </div>
  );
}
