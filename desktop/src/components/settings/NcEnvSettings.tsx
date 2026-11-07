import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { failureText } from "../../lib/friendlyError";
import { errorToast } from "../../lib/errorToast";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import {
  ncHomeCandidates,
  ncHomeProbe,
  ncHomeSet,
  serverStatus,
  type HomeCandidate,
  type NcHome,
} from "../../lib/server";
import "./settings-ncenv.css";

/** 跳到别的工具页（与 HeaderMenus 应用菜单同一套事件，见 App.tsx 的监听）。 */
const goTab = (tab: string) => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: tab }));

/**
 * 设置 → 开发 → 「NC 环境」：NC 安装目录（NC home）的固定配置处。
 *
 * 为什么单开这一页（2026-11-06）：home 的判定（`nc_home::probe`，按内容识别）
 * 一直很稳，但**发现**和**入口**是缺口——没配置时只试一个硬编码默认位置，
 * 唯一能改的地方埋在「NC 服务」页顶部一条配置栏里，还只能手敲路径。
 * 这里把三件事收口：显式配置（浏览 + 手输）、自动探测候选、环境自检。
 *
 * **全应用唯一的 home 编辑入口**：服务页、补丁页健康条、各处报错文案都只读
 * 展示 + 跳转到这里，不再有第二个能改 home 的地方（数据流本来就走同一份
 * `AppConfig.nc_home`，统一的是入口与展示）。
 *
 * 运行中改 home 不杀正在跑的 JVM：端口按新 home 的 prop.xml 读，会出现
 * 「启动中」假象，所以先问一句（与「NC 服务」页原 PathField 同一套守卫）。
 */
export function NcEnvSettings() {
  const qc = useQueryClient();
  const probe = useQuery({
    queryKey: ["nc-home"],
    queryFn: () => ncHomeProbe(),
    staleTime: 30_000,
    retry: false,
  });
  // 只为拿「服务在不在跑」：改 home 时决定要不要弹确认框。
  const server = useQuery({
    queryKey: ["server-status"],
    queryFn: serverStatus,
    staleTime: 5_000,
    retry: false,
  });

  /** 编辑中的路径草稿；null = 展示态。 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** 候选扫描结果；null = 还没扫过（与「扫了但没有」是两回事）。 */
  const [cands, setCands] = useState<HomeCandidate[] | null>(null);
  /** 运行中切换的确认闸：用户在弹窗上选完才继续保存。 */
  const [pending, setPending] = useState<{ path: string; resolve: (ok: boolean) => void } | null>(null);

  const running = server.data?.state === "running" || server.data?.state === "starting";
  const home: NcHome | undefined = probe.data;
  const current = home?.root ?? "";

  const save = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    if (running && !(await new Promise<boolean>((resolve) => setPending({ path: p, resolve })))) return;
    setSaving(true);
    try {
      const saved = await ncHomeSet(p);
      qc.setQueryData(["nc-home"], saved);
      setDraft(null);
      toast(running ? "NC 安装目录已保存，重启服务后生效" : "NC 安装目录已切换", "success");
      // home 换了：服务状态（端口）与补丁默认值（落位层）都按新 home 重读
      void qc.invalidateQueries({ queryKey: ["server-status"] });
      void qc.invalidateQueries({ queryKey: ["patch-defaults"] });
    } catch (e) {
      errorToast("保存 NC 安装目录", e);
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    try {
      const picked = await pickFolder({ title: "选择 NC 安装目录（含 ufjdk 的那一层）", defaultPath: current || undefined });
      if (picked) await save(picked);
    } catch (e) {
      toast(pickFolderError(e), "error");
    }
  };

  const scan = async () => {
    setScanning(true);
    try {
      const list = await ncHomeCandidates();
      setCands(list);
      if (list.length === 0) toast("没扫到 NC 安装目录：换「浏览」手动指定", "info");
    } catch (e) {
      errorToast("扫描候选目录", e);
    } finally {
      setScanning(false);
    }
  };

  const probeSummary = home
    ? [
        `${home.moduleCount} 个模块`,
        "自带 java 1.8",
        home.hasNcStarter ? "完整安装" : "被裁剪过（无 startup.bat）",
        home.httpPort ? `端口 ${home.httpPort}` : "端口未读到",
      ].join(" · ")
    : "尚未识别";

  return (
    <div className="settings-section-block">
      <SettingsGroup
        title="NC 安装目录"
        summary={current || "未配置"}
        defaultOpen
      >
        <SettingsRow
          label="安装目录"
          sub="含 ufjdk、modules、middleware 的那一层。编译类路径、启动服务、补丁落位都从这里读"
          layout="stack"
          control={
            draft === null ? (
              <div className="settings-ncenv-path">
                <span className="settings-ncenv-path-text" title={current || "未配置"}>
                  {current || <span className="text-muted-foreground">未配置</span>}
                </span>
                <Button size="sm" variant="outline" onClick={() => void browse()} disabled={saving}>
                  <Icon name="folderPlus" size={13} />浏览…
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(current)} disabled={saving}>
                  更改
                </Button>
              </div>
            ) : (
              <div className="settings-ncenv-path">
                <input
                  autoFocus
                  className="settings-memory-input grow"
                  aria-label="NC 安装目录"
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") { e.preventDefault(); void save(draft); }
                    if (e.key === "Escape") setDraft(null);
                  }}
                />
                <Button size="sm" onClick={() => void save(draft)} disabled={saving} isLoading={saving} loadingText="保存中">
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                  取消
                </Button>
              </div>
            )
          }
        />
        <SettingsRow
          label="探测结果"
          sub={
            probe.isLoading
              ? "正在识别…"
              : probe.error
                ? failureText("探测 NC 环境", probe.error)
                : probeSummary
          }
          last
          control={
            probe.error ? (
              <Button size="sm" variant="outline" onClick={() => void probe.refetch()}>
                重试
              </Button>
            ) : undefined
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="自动探测"
        summary={cands ? `${cands.length} 个候选` : "扫描常见位置"}
      >
        <SettingsRow
          label="扫描常见位置"
          sub="扫各硬盘根目录下两级，以及当前工作区的同级目录。只做轻量识别，点「使用」后才会完整校验"
          control={
            <Button size="sm" variant="outline" onClick={() => void scan()} isLoading={scanning} loadingText="扫描中">
              <Icon name="search" size={13} />扫描
            </Button>
          }
        />
        {cands && cands.length > 0 && (
          <div className="settings-ncenv-cands" role="list" aria-label="扫描到的候选">
            {cands.map((c) => (
              <div className="settings-ncenv-cand" key={c.root} role="listitem">
                <div className="settings-ncenv-cand-main">
                  <span className="settings-ncenv-path-text" title={c.root}>{c.root}</span>
                  <span className="settings-ncenv-cand-src">
                    {c.source === "driveRoot" ? "硬盘目录" : "工作区同级"}
                  </span>
                  <span className="text-xs text-muted-foreground">{c.moduleCount} 个模块</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={saving || c.root === current}
                  onClick={() => void save(c.root)}
                >
                  {c.root === current ? "当前配置" : "使用"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="环境自检" summary={probe.error ? "home 待修复" : "四项就绪度"}>
        <div className="settings-ncenv-check" data-tone={probe.error ? "bad" : home ? "ok" : "idle"}>
          <span className="settings-ncenv-check-dot" aria-hidden="true" />
          <span className="settings-ncenv-check-k">NC home</span>
          <span className="settings-ncenv-check-d">
            {probe.error ? "未识别，换一个目录" : home ? current : "读取中…"}
          </span>
        </div>
        <div className="settings-ncenv-check" data-tone={home ? "ok" : "idle"}>
          <span className="settings-ncenv-check-dot" aria-hidden="true" />
          <span className="settings-ncenv-check-k">java 1.8</span>
          <span className="settings-ncenv-check-d">
            {home ? home.java.replace(/^.*[\\/]/, "") : "home 未识别"}
          </span>
        </div>
        <div className="settings-ncenv-check" data-tone={home ? (home.httpPort ? "ok" : "warn") : "idle"}>
          <span className="settings-ncenv-check-dot" aria-hidden="true" />
          <span className="settings-ncenv-check-k">中间件端口</span>
          <span className="settings-ncenv-check-d">
            {!home
              ? "home 未识别"
              : home.httpPort
                ? `${home.httpPort}（ierp/bin/prop.xml）`
                : "prop.xml 读不到，端口按默认 80 处理"}
          </span>
          {home && (
            <span className="settings-ncenv-check-act">
              <Button size="sm" variant="ghost" onClick={() => goTab("services")}>去服务页</Button>
            </span>
          )}
        </div>
        <div className="settings-ncenv-check" data-tone="idle">
          <span className="settings-ncenv-check-dot" aria-hidden="true" />
          <span className="settings-ncenv-check-k">数据库连接</span>
          <span className="settings-ncenv-check-d">在数据库页管理，与 home 无关</span>
          <span className="settings-ncenv-check-act">
            <Button size="sm" variant="ghost" onClick={() => goTab("db")}>去连接</Button>
          </span>
        </div>
      </SettingsGroup>

      <ConfirmDialog
        open={pending !== null}
        title="服务正在运行，切换 NC 安装目录？"
        description={<>在跑的 JVM 不会重读配置：<b>新目录要停止并重启服务才生效</b>。切换后状态栏会按新目录的 prop.xml 报告端口，可能出现「启动中」或端口冲突提示——那是旧进程还在用旧配置，不是它没停下来。</>}
        confirmLabel="仍然切换"
        onCancel={() => { pending?.resolve(false); setPending(null); }}
        onConfirm={() => { pending?.resolve(true); setPending(null); }}
      />
    </div>
  );
}
