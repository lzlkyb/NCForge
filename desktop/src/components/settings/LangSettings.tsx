import { useEffect, useRef, useState } from "react";
import { getConfig, langConfigSet, langRegenerate, type AppConfig, type LangConfigPatch } from "../../lib/appConfig";
import { applyLangPrefs, useLangView, type LangState } from "../../lib/lang";
import { Button } from "../ui/button";
import { missingResourceId } from "../../lib/resourceMissing";
import { ResourceDownloadButton } from "../resource/ResourceDownloadButton";
import { Card } from "../ui/card";
import { LangMemoryField } from "./LangMemoryField";
import { Badge } from "../ui/badge";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { toast } from "../ui/toast";
import { InlineNotice } from "../ui/notice";
import { Skeleton } from "../ui/Skeleton";
import { failureText } from "../../lib/friendlyError";
import "./settings-development.css";

/** 与 Rust `lang::DEFAULT_XMX_MB` 一致。后端是权威，这里只用来显示。 */
const DEFAULT_XMX_MB = 1024;
const STATE_LABELS: Record<LangState, string> = {
  stopped: "未启动", starting: "启动中", indexing: "建立索引中", ready: "已就绪", error: "启动失败",
};
const STATE_DESCRIPTIONS: Record<LangState, string> = {
  stopped: "打开模块后可启动代码智能。", starting: "正在准备代码补全与跳转。",
  indexing: "正在读取工程，代码补全可能暂未完整。", ready: "代码补全、跳转与错误提示已可用。",
  error: "代码智能启动失败，请查看失败原因。",
};
type SaveFeedback = { pending: string | null; saved: string | null; errorKey?: string; error?: string };

/**
 * 「代码智能」设置卡（设计稿第 4 幕）：总开关、内存上限、自动启动、重新生成影子工程，
 * 以及一张「能力边界」说明卡——不掩饰它做不到的事。
 */
export function LangSettings() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [feedback, setFeedback] = useState<SaveFeedback>({ pending: null, saved: null });
  const [rebuilding, setRebuilding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const view = useLangView();
  const saving = useRef(false);
  const rebuildingRef = useRef(false);
  const mounted = useRef(true);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(savedTimer.current); };
  }, []);

  // 读失败以前被吞进空 catch，整张卡 `return null`：设置页凭空少一块，
  // 没有骨架、没有红条、没有重试，用户只能以为「这版没这个功能」。
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setLoadError(null);
    getConfig().then(
      (c) => {
        if (dead) return;
        setCfg(c);
        setLoading(false);
      },
      (e) => {
        if (dead) return;
        setLoadError(failureText("读取代码智能设置", e));
        setLoading(false);
      },
    );
    return () => {
      dead = true;
    };
  }, [reload]);

  const apply = async (patch: LangConfigPatch, key: string) => {
    if (saving.current) return false;
    saving.current = true;
    clearTimeout(savedTimer.current);
    setFeedback({ pending: key, saved: null });
    try {
      const next = await langConfigSet(patch);
      applyLangPrefs(next);
      if (mounted.current) {
        setCfg(next);
        setFeedback({ pending: null, saved: key });
        savedTimer.current = setTimeout(() => setFeedback({ pending: null, saved: null }), 2000);
      }
      return true;
    } catch (e) {
      if (mounted.current) setFeedback({ pending: null, saved: null, errorKey: key, error: failureText("保存代码智能设置", e) });
      return false;
    } finally {
      saving.current = false;
    }
  };

  const rebuild = async () => {
    if (rebuildingRef.current) return;
    rebuildingRef.current = true;
    setRebuilding(true);
    try {
      await langRegenerate();
      toast("工程已重新生成，代码智能索引仍在准备", "success");
    } catch (e) {
      toast(failureText("重新生成影子工程", e), "error");
    } finally {
      rebuildingRef.current = false;
      if (mounted.current) setRebuilding(false);
    }
  };

  if (!cfg) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <div className="text-sm font-medium">代码智能</div>
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="正在读取代码智能设置">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-52" />
          </div>
        ) : (
          <InlineNotice variant="error">
            <div className="flex flex-col items-start gap-2">
              <span>{loadError ?? "读取设置失败"}</span>
              <Button variant="ghost" size="sm" onClick={() => setReload((n) => n + 1)}>
                重试
              </Button>
            </div>
          </InlineNotice>
        )}
      </Card>
    );
  }
  const off = !cfg.lang_enabled;
  const busy = feedback.pending !== null;
  const disabledReason = off ? "请先启用代码智能" : busy ? "正在保存，请稍候" : undefined;

  return (
    <>
      <Card className="flex flex-col gap-1 p-2">
        <div className="settings-lang-status">
          <Badge variant={off ? "secondary" : view.state === "error" ? "destructive" : view.state === "ready" ? "success" : "secondary"}>
            {off ? "轻量模式" : STATE_LABELS[view.state]}
          </Badge>
          <p className="text-xs text-muted-foreground">{off ? "代码智能已暂停，编译功能仍可使用。" : view.state === "error" && view.message ? view.message : STATE_DESCRIPTIONS[view.state]}</p>
          {!off && view.state === "error" && missingResourceId(view.message) === "jdtls" && <ResourceDownloadButton id="jdtls" />}
        </div>
        <ToggleRow
          id="lang-enabled"
          label="启用代码智能"
          sub="关闭后进入轻量模式，暂停语言服务与语义着色"
          info="关掉后仍有编译报错（ecj）和按类名查找声明的有限跳转，但没有补全、悬停、语义着色和实时错误提示。状态栏的「轻量模式」徽标也能直接恢复。"
          checked={cfg.lang_enabled}
          saved={feedback.saved === "enabled"}
          pending={feedback.pending === "enabled"}
          disabled={busy}
          disabledReason={busy ? "正在保存，请稍候" : undefined}
          error={feedback.errorKey === "enabled" ? feedback.error : undefined}
          keywords={["Java", "JDK", "jdt.ls", "轻量模式"]}
          onChange={(v) => void apply({ lang_enabled: v }, "enabled")}
        />
        <SettingsRow
          id="lang-memory"
          label="内存上限"
          sub={off ? "先启用代码智能后可调整" : "512–4096 MB；下次启动代码智能时生效"}
          info="这是 jdt.ls 的堆内存上限，不是工作台的总内存。修改后需要下次启动语言服务才生效。"
          saved={feedback.saved === "xmx"}
          pending={feedback.pending === "xmx"}
          error={feedback.errorKey === "xmx" ? feedback.error : undefined}
          valueText={`${cfg.lang_xmx_mb ?? DEFAULT_XMX_MB} MB · 下次启动生效`}
          keywords={["堆", "JVM", "内存限制"]}
          control={
            <LangMemoryField
              value={cfg.lang_xmx_mb ?? DEFAULT_XMX_MB}
              disabled={off || busy}
              pending={feedback.pending === "xmx"}
              onSave={(v) => apply({ lang_xmx_mb: v }, "xmx")}
            />
          }
        />
        <ToggleRow
          id="lang-auto-start"
          label="打开新模块时自动启动"
          sub={off ? "先启用代码智能后可设置自动启动" : "关闭后可在状态栏手动启动"}
          checked={cfg.lang_auto_start}
          saved={feedback.saved === "auto"}
          disabled={off || busy}
          disabledReason={disabledReason}
          pending={feedback.pending === "auto"}
          error={feedback.errorKey === "auto" ? feedback.error : undefined}
          onChange={(v) => void apply({ lang_auto_start: v }, "auto")}
        />
        <SettingsRow
          id="lang-rebuild"
          label="重新生成影子工程"
          sub={off ? "先启用代码智能后可重建" : "模块目录变化后，重新生成并建立索引"}
          info="重建会刷新影子工程及索引。耗时取决于当前工程规模，重建期间代码补全可能暂未就绪。"
          valueText={off ? "需启用代码智能" : rebuilding ? "重建中" : "可重建"}
          last
          control={
            <Button variant="outline" size="sm" isLoading={rebuilding} loadingText="重建中…" disabled={off || busy || rebuilding} title={disabledReason} onClick={() => void rebuild()}>
              {rebuilding ? "重建中…" : "重新建立"}
            </Button>
          }
        />
      </Card>

      <details className="settings-lang-capabilities" id="lang-capabilities" tabIndex={-1} data-settings-item
        data-settings-label="代码智能能力说明" data-settings-description="跳转范围、补全与大文件限制"
        data-setting-value="按需查看">
        <summary>能力说明与常见限制</summary>
        <div>
        <p>
          <b className="text-foreground">能跳的：</b>
          当前模块内的类与方法；NC 标准类（有 _src.jar 的看到真实源码，其余看到方法签名）；其他模块的二开类只能看到签名（来自上次编译的 class）。
        </p>
        <p>
          <b className="text-foreground">补全不到的情况：</b>
          刚切过来的模块索引还没建好时补全会缺类；其他业务模块的私有类也可能补不出来，切过去即可。
        </p>
        <p>
          <b className="text-foreground">超大文件：</b>
          约 6000 行以上的文件（如 VoucherBO.java，6433 行）补全返回为空，编辑器顶部会提示，不是功能坏了。
        </p>
        <p>
          <b className="text-foreground">不做的：</b>
          跨 jar 的「查找引用」与自动重命名。引用查找请用代码页侧栏的「全工程搜索」（Ctrl+K），重命名风险太高，一期不做。
        </p>
        </div>
      </details>
    </>
  );
}
