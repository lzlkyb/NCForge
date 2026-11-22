import { useRef, useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/toast";
import { launchSummary, type LaunchConfig, type LaunchKind } from "../../lib/launchConfigs";
import { useLaunchConfigs } from "../../hooks/useLaunchConfigs";

/** 命名弹窗里展示「将保存成什么」。 */
const summaryOf = (target: LaunchConfig["target"]) => launchSummary({ id: "", name: "", target });

/**
 * 启动配置下拉 + 「保存为配置 / 复制 / 删除」。
 *
 * 放在服务抽屉（中间件、客户端各一份）与 Java 运行面板（java 目标）里。
 * 样式只用 Tailwind 与 `wb-status-btn`：两个宿主的 CSS 都会加载这两样，
 * 不依赖服务页独有的 `sv-cfg-*`（Java 面板不一定加载过 services.css）。
 *
 * 「保存为配置」的快照由调用方给（`snapshot`）——必须是**当前真实会怎么起**
 * 的值（后端收口后的堆、生效的 web 应用名单、调试开关），存 Null 的项
 * 表示跟随全局配置，与 Eclipse 里空着的字段同义。
 */
export function LaunchConfigPicker({
  kind,
  label,
  snapshot,
  onSelected,
}: {
  kind: LaunchKind;
  /** 行首标签（抽屉里按目标区分，Java 面板里只有一个）。 */
  label: string;
  /** 「保存为配置」的当前真实值，由调用方按各自状态拼。 */
  snapshot: LaunchConfig;
  /** 选中变化后的副作用：同步调试开关 / 回填 Java 表单。 */
  onSelected?: (config: LaunchConfig | null) => void;
}) {
  const { configs, selected, notes, select, save, duplicate, remove } = useLaunchConfigs(kind);
  const [naming, setNaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const choose = (id: string) => {
    const config = configs.find((c) => c.id === id) ?? null;
    select(config?.id ?? null);
    onSelected?.(config);
  };
  /** 默认名「配置 N」，跳过已占用的序号（后端重名会直接报错）。 */
  const suggestName = () => {
    const taken = new Set(configs.map((c) => c.name));
    for (let i = configs.length + 1; i <= 999; i++) {
      const name = `配置 ${i}`;
      if (!taken.has(name)) return name;
    }
    return `配置 ${Date.now() % 100000}`;
  };
  const confirmSave = async () => {
    if (savingRef.current || naming === null) return;
    const name = naming.trim();
    if (!name) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const created = await save({ id: "", name, target: snapshot.target });
      if (created) {
        select(created.id);
        onSelected?.(created);
        toast(`已保存启动配置「${created.name}」，仅下次启动生效`, "success");
      }
      setNaming(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const confirmDuplicate = async () => {
    if (!selected) return;
    const created = await duplicate(selected.id);
    if (created) {
      select(created.id);
      onSelected?.(created);
      toast(`已复制为「${created.name}」`, "success");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 py-1.5">
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <select
          className="h-[26px] min-w-0 max-w-[240px] flex-1 rounded-[var(--r-control)] border border-border bg-transparent px-2 text-xs text-foreground"
          value={selected?.id ?? ""}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">默认（跟随全局配置）</option>
          {configs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.name} · {launchSummary(config)}
            </option>
          ))}
        </select>
        <button type="button" className="wb-status-btn" onClick={() => setNaming(suggestName())}>
          保存为配置
        </button>
        {selected && (
          <>
            <button type="button" className="wb-status-btn" onClick={() => void confirmDuplicate()}>
              复制
            </button>
            <button type="button" className="wb-status-btn" onClick={() => setRemoving(true)}>
              删除
            </button>
          </>
        )}
      </div>
      {notes.length > 0 && (
        <p className="py-1 text-xs text-warning-ink">{notes.join("；")}</p>
      )}
      {configs.length === 0 && notes.length === 0 && (
        <p className="py-1 text-xs text-muted-foreground">还没有启动配置；按当前参数点「保存为配置」即可留存，下次直接选。</p>
      )}

      <ConfirmDialog
        open={naming !== null}
        title="保存为启动配置"
        description={<>将按当前生效值保存：{summaryOf(snapshot.target)}。仅下次启动生效，不修改全局配置。</>}
        confirmLabel="保存"
        confirmDisabled={!naming?.trim() || saving}
        onCancel={() => setNaming(null)}
        onConfirm={() => void confirmSave()}
      >
        <label className="block text-sm text-muted-foreground">
          名称
          <input
            className="mt-1 block h-[30px] w-full rounded-md border border-border bg-transparent px-2 text-[13px] text-foreground"
            value={naming ?? ""}
            placeholder="例如：中间件 8G · 全量 web"
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void confirmSave(); }
            }}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={removing}
        variant="destructive"
        title={`删除启动配置「${selected?.name ?? ""}」？`}
        description="只删除配置本身，不影响正在运行的服务；下次启动需重新选择。"
        confirmLabel="删除"
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false);
          if (selected) void remove(selected.id);
        }}
      />
    </>
  );
}
