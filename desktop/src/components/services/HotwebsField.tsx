import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Modal } from "../ui/Modal";
import type { HotwebsInfo } from "../../lib/server";
import { failureText } from "../../lib/friendlyError";

/** 两份名单是否同集合（顺序、重复都不算差异）。 */
function sameSet(a: string[], b: string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((n, i) => n === sb[i]);
}

/**
 * 启动时挂载的 web 应用（`-Duap.hotwebs`）。
 *
 * 为什么要给开关：`develop` 模式下它是**白名单**。多挂一个目录就多初始化一个 Spring
 * 上下文，而这些 webapp 共用同一条 classpath——插件自带的 Spring 版本和 NC 不一致时
 * 会在启动阶段炸掉（实测 HR 的 `ncchr` 因 spring-data-redis 2.1.6 调 Spring 5 API
 * 而 `Context [/ncchr] startup failed`）。Eclipse 的启动配置只挂 5 个，所以默认名单
 * 与 Eclipse 一致；需要 iwebap / eyeapp 等前端时在这里按需勾选。
 */
export function HotwebsField({
  info,
  error,
  running,
  onSave,
}: {
  /** 后端探针结果；null = 还在读或读失败。 */
  info: HotwebsInfo | null;
  error: string | null;
  /** 服务是否在跑：名单是启动参数，改了要重启才生效。 */
  running: boolean;
  /** 保存并返回后端规范化后的结果。传 null = 恢复默认。 */
  onSave: (hotwebs: string[] | null) => Promise<HotwebsInfo>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // 每次打开只从「当前生效名单」初始化一次：探针在对话框打开后才回来时要补上，
  // 但后台 refetch 不能把用户刚勾的选择冲掉
  const seeded = useRef(false);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (info && !seeded.current) {
      setSelected(info.active);
      seeded.current = true;
    }
  }, [open, info]);

  const count = info?.active.length ?? 0;
  const isDefault = !!info && info.configured === null;
  const hint = info
    ? isDefault
      ? "默认 · 与 Eclipse 一致"
      : "自定义"
    : error
      ? "读取失败"
      : "读取中…";

  const toggle = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const save = async () => {
    if (savingRef.current) return;
    if (!info) return;
    if (selected.length === 0) {
      toast("至少要挂载一个 web 应用", "error");
      return;
    }
    // 与默认名单一致时存 null：config.json 里不出现一份「恰好等于默认」的显式表，
    // 以后默认名单调整了才能跟着走（后端也会做同样的规范化，这里只是先说清楚）
    const isDefaultSelection = sameSet(selected, info.default);
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await onSave(isDefaultSelection ? null : selected);
      setSelected(saved.active);
      toast(
        isDefaultSelection
          ? `Web 应用已恢复默认${running ? "，重启服务后生效" : ""}`
          : `Web 应用已保存${running ? "，重启服务后生效" : "，下次启动生效"}`,
        "success",
      );
      setOpen(false);
    } catch (e) {
      // 不吞错：后端会说清哪个目录不存在、或者为什么空名单不行
      toast(failureText("保存 Web 应用", e), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <div className="sv-cfg-item sv-cfg-hotwebs">
        <span className="sv-cfg-k">Web 应用</span>
        <span className="sv-cfg-v" title={info ? info.active.join(", ") : undefined}>
          {info ? `${count} 个` : "—"}
        </span>
        <span className="sv-cfg-hint" title={error ?? undefined}>
          {hint}
        </span>
        <span className="sv-sp" />
        <button
          type="button"
          className="sv-link"
          title="选择启动时要挂载的 hotwebs 目录"
          onClick={() => setOpen(true)}
        >
          选择
        </button>
      </div>

      <Modal
        open={open}
        onClose={() => {
          if (!savingRef.current) setOpen(false);
        }}
        className="modal-surface w-[620px] max-w-[92vw] p-5"
        ariaLabel="选择 Web 应用"
      >
        <div className="flex items-center gap-2">
          <Icon name="settings" size={15} />
          <h2 className="text-sm font-semibold">Web 应用</h2>
          {info && (
            <span className="text-xs text-muted-foreground">
              已选 {selected.length} / {info.all.length}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            className="sv-icon-btn"
            disabled={saving}
            onClick={() => setOpen(false)}
            title="关闭"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <p className="sv-hw-note">
          默认名单与 Eclipse 的启动配置一致。多挂一个 web 应用就多初始化一个 Spring
          上下文，它们共用同一条 classpath；插件自带的 Spring 版本与 NC 不一致时会启动失败
          （例如 HR 的 <code>ncchr</code>）。需要其它前端时再勾选。
        </p>

        {!info ? (
          <p className="sv-port-err" role="alert">
            {error ? `读取失败：${error}` : "正在读取 hotwebs 目录…"}
          </p>
        ) : info.all.length === 0 ? (
          <p className="sv-port-err" role="alert">
            在 NC 安装目录下没找到 hotwebs/ 子目录，无法选择。
          </p>
        ) : (
          <div className="sv-hw-list">
            {info.all.map((name) => {
              const checked = selected.includes(name);
              const fallback = info.default.includes(name);
              return (
                <label className="sv-hw-item" key={name} data-on={checked || undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving}
                    onChange={() => toggle(name)}
                  />
                  <span className="sv-hw-name">{name}</span>
                  {fallback && <span className="sv-hw-badge">默认</span>}
                </label>
              );
            })}
          </div>
        )}

        <div className="sv-port-foot">
          <span className="sv-port-hint">
            {running
              ? "名单写在启动参数里，保存后要重启服务才生效。"
              : "下次启动服务时生效。"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="sv-btn"
            disabled={saving || !info}
            onClick={() => info && setSelected(info.default)}
          >
            恢复默认
          </button>
          <button type="button" className="sv-btn" disabled={saving} onClick={() => setOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="sv-btn sv-btn-primary"
            disabled={saving || !info || selected.length === 0}
            title={selected.length === 0 ? "至少要挂载一个 web 应用" : undefined}
            onClick={() => void save()}
          >
            {saving && <Icon name="spinner" size={13} className="animate-spin" />}
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </Modal>
    </>
  );
}
