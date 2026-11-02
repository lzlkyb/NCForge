import { useEffect, useState } from "react";
import { getConfig, langConfigSet, langRegenerate, type AppConfig, type LangConfigPatch } from "../../lib/appConfig";
import { applyLangPrefs } from "../../lib/lang";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { InlineNum } from "../ui/InlineNum";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { toast } from "../ui/toast";
import { InlineNotice } from "../ui/notice";
import { Skeleton } from "../ui/Skeleton";
import { failureText } from "../../lib/friendlyError";

/** 与 Rust `lang::DEFAULT_XMX_MB` 一致。后端是权威，这里只用来显示。 */
const DEFAULT_XMX_MB = 1024;

/**
 * 「代码智能」设置卡（设计稿第 4 幕）：总开关、内存上限、自动启动、重新生成影子工程，
 * 以及一张「能力边界」说明卡——不掩饰它做不到的事。
 */
export function LangSettings() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

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
    try {
      const next = await langConfigSet(patch);
      setCfg(next);
      applyLangPrefs(next);
      setSavedKey(key);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2000);
    } catch (e) {
      // 内存上限越界时后端会说明允许范围，原文展示即可
      toast(failureText("保存代码智能设置", e), "error");
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await langRegenerate();
      toast("已重新生成，正在重建索引（约 40 秒）", "success");
    } catch (e) {
      toast(failureText("重新生成影子工程", e), "error");
    } finally {
      setRebuilding(false);
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

  return (
    <>
      <Card className="flex flex-col gap-1 p-2">
        <div className="px-2 pt-2">
          <div className="text-sm font-medium">代码智能</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            补全、跳转、错误提示由内置的 jdt.ls 0.57.0 提供，跑在 NC 自带的 JDK 1.8 上。
          </div>
        </div>
        <ToggleRow
          label="启用代码智能"
          sub="关掉即轻量模式：暂停 jdt.ls 与语义着色，省约 650MB 内存"
          info="关掉后仍有编译报错（ecj）和按类名查找声明的有限跳转，但没有补全、悬停、语义着色和实时错误提示。状态栏的「轻量模式」徽标也能直接恢复。"
          checked={cfg.lang_enabled}
          saved={savedKey === "enabled"}
          onChange={(v) => void apply({ lang_enabled: v }, "enabled")}
        />
        <SettingsRow
          label="内存上限"
          sub="jdt.ls 的堆上限，512~4096；改后下次启动生效"
          saved={savedKey === "xmx"}
          control={
            <InlineNum
              value={cfg.lang_xmx_mb ?? DEFAULT_XMX_MB}
              saved={false}
              unit="MB"
              ariaLabel="代码智能内存上限（MB）"
              onSave={(v) => apply({ lang_xmx_mb: v }, "xmx")}
            />
          }
        />
        <ToggleRow
          label="打开新模块时自动启动"
          sub="关掉后要在状态栏手动启动，适合内存紧张时"
          checked={cfg.lang_auto_start}
          saved={savedKey === "auto"}
          disabled={off}
          onChange={(v) => void apply({ lang_auto_start: v }, "auto")}
        />
        <SettingsRow
          label="重新生成影子工程"
          sub="新增或删除了模块目录后点这里，会重建索引"
          last
          control={
            <Button variant="ghost" size="sm" disabled={off || rebuilding} onClick={() => void rebuild()}>
              {rebuilding ? "重建中…" : "重新建立"}
            </Button>
          }
        />
      </Card>

      <Card className="flex flex-col gap-1.5 p-4 text-xs text-muted-foreground">
        <div className="text-sm font-medium text-foreground">能力边界</div>
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
      </Card>
    </>
  );
}
