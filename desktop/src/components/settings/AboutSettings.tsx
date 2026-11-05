import { useEffect, useRef, useState } from "react";
import { useAppInfo } from "../../hooks/useAppInfo";
import { APP_INFO, CHANGELOG } from "../../lib/about";
import { displayPlatform, versionInfoText } from "../../lib/aboutRuntime";
import { LICENSE_COPYRIGHT } from "../../lib/license";
import { invoke } from "../../lib/tauri";
import { copyText } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Icon } from "../ui/icon";
import { AboutUpdateAction } from "./AboutUpdateAction";
import { LicenseDialog } from "./LicenseDialog";
import { ReleaseText } from "./ReleaseText";
import "./settings-about.css";

export function AboutSettings({ onOpenHistory }: { onOpenHistory: () => void }) {
  const info = useAppInfo();
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [pending, setPending] = useState<"copy" | "repo" | "issues" | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const locked = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const version = info.data?.version?.trim();
  const loading = !version && (info.isPending || info.isFetching);
  const unavailable = !version && !loading;
  const current = CHANGELOG.find(entry => entry.version === version?.replace(/^v/, ""));
  // A bundled record may be newer than this executable. It must never masquerade as the running version.
  const release = current ?? CHANGELOG[0];
  const platform = displayPlatform(info.data?.platform);
  const report = (text: string, error = false) => { if (alive.current) setFeedback({ text, error }); };
  const perform = async (action: "copy" | "repo" | "issues") => {
    if (locked.current || (action === "copy" && !version)) return;
    locked.current = true; setPending(action); setFeedback(null);
    try {
      if (action === "copy") await copyText(versionInfoText(version!, info.data?.platform),
        () => report("版本信息已复制，可附在问题反馈中。"), () => report("复制失败，请检查剪贴板权限后重试。", true));
      else {
        await invoke("open_external", { url: action === "repo" ? APP_INFO.repoUrl : `${APP_INFO.repoUrl}/issues` });
        report("已交给系统浏览器打开。");
      }
    } catch { report("打开链接失败，请检查系统浏览器后重试。", true); }
    finally { locked.current = false; if (alive.current) setPending(null); }
  };
  const copyButton = <Button variant="link" size="sm" disabled={!version || Boolean(pending)} isLoading={pending === "copy"} loadingText="复制中…"
    title={!version ? "读取运行版本后可复制信息" : undefined} onClick={() => void perform("copy")}><Icon name="copy" size={14} />复制版本信息</Button>;
  return (
    <Card className="settings-about">
      <div className="settings-about-product" id="about-version" data-settings-item="" data-settings-label="运行版本" data-settings-description={platform}
        data-settings-keywords="版本号 version 平台 Windows macOS Linux" data-setting-value={version ? `v${version.replace(/^v/, "")}` : loading ? "读取中" : "版本未知"} tabIndex={-1}>
        <img src="/icon.png" width={48} height={48} alt="" />
        <div className="settings-about-identity"><div className="settings-about-name"><h2>{APP_INFO.name}</h2>
          {loading ? <span className="settings-about-skeleton" role="status" aria-label="正在读取版本" /> : <span>{version ? `v${version.replace(/^v/, "")}` : "版本未知"}</span>}
        </div><p className="settings-about-description">{APP_INFO.description}</p>
          <div className="settings-about-runtime"><span>{platform}</span><span>代码 · 版本控制 · 数据库 · 元数据 · NC 调试</span></div></div>
      </div>
      <div className="settings-about-toolbar"><AboutUpdateAction versionKnown={Boolean(version)}>
        <Button variant="outline" size="sm" onClick={onOpenHistory}><Icon name="clock" size={14} />查看更新历史</Button>{copyButton}
        {(unavailable || info.isError) && <Button variant="outline" size="sm" isLoading={info.isFetching} loadingText="读取中…" onClick={() => void info.refetch()}>重新读取版本</Button>}
      </AboutUpdateAction></div>
      {unavailable && <p className="settings-about-feedback is-error" role="alert">{info.isError ? "版本信息读取失败，可重新读取；更新记录仍可查看。" : "返回的版本信息不完整，可重新读取。"}</p>}
      {feedback && <p className={`settings-about-feedback ${feedback.error ? "is-error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      <section className="settings-about-section" id="about-history" data-settings-item="" data-settings-label="更新历史" data-settings-keywords="发行说明 changelog 版本记录"
        data-setting-value={`${CHANGELOG.length} 个随包版本`} tabIndex={-1} aria-labelledby="about-history-title">
        <div className="settings-about-section-head"><h2 id="about-history-title">{current ? "本版本更新" : "随包更新记录"}</h2>
          {release && <span>v{release.version} · 记录日期 {release.date}</span>}</div>
        {(release?.summary ?? release?.highlights ?? []).slice(0, 2).map((text, index) => <p key={index} className="settings-about-release-summary"><ReleaseText text={text} /></p>)}
        {release?.items.length ? <ul className="settings-about-highlights">{release.items.slice(0, 3).map((item, index) => <li key={index}><ReleaseText text={item.text} /></li>)}</ul> : <p className="settings-about-description">还没有随包条目记录。</p>}
        <Button variant="link" size="sm" onClick={onOpenHistory}>查看完整版本记录</Button>
      </section>
      <section className="settings-about-section" aria-labelledby="about-project-title"><div className="settings-about-section-head"><h2 id="about-project-title">项目与许可</h2></div>
        <div className="settings-about-row" id="about-repo" data-settings-item="" data-settings-label="项目仓库" data-settings-keywords="源码 GitHub repository" data-setting-value={APP_INFO.repoUrl} tabIndex={-1}>
          <span className="settings-about-row-label">项目仓库</span><span className="settings-about-row-value">{APP_INFO.repoUrl.replace(/^https:\/\//, "")}</span>
          <Button variant="outline" size="sm" disabled={Boolean(pending)} isLoading={pending === "repo"} loadingText="打开中…" onClick={() => void perform("repo")}>打开仓库<Icon name="external" size={13} /></Button></div>
        <div className="settings-about-row" id="about-feedback" data-settings-item="" data-settings-label="问题反馈" data-settings-keywords="bug 反馈 支持" tabIndex={-1}>
          <span className="settings-about-row-label">问题反馈</span><span className="settings-about-row-value is-description">报告问题时可附上版本信息与复现步骤。</span>
          <Button variant="outline" size="sm" disabled={Boolean(pending)} isLoading={pending === "issues"} loadingText="打开中…" onClick={() => void perform("issues")}>反馈问题<Icon name="external" size={13} /></Button></div>
        <div className="settings-about-row" id="about-license" data-settings-item="" data-settings-label="开源许可" data-settings-keywords="协议 license MIT 版权" data-setting-value={APP_INFO.license} tabIndex={-1}>
          <span className="settings-about-row-label">开源许可</span><span className="settings-about-row-value">MIT License</span><Button variant="outline" size="sm" onClick={() => setLicenseOpen(true)}>查看许可</Button></div>
        <p className="settings-about-copyright">{LICENSE_COPYRIGHT}。版权与使用条件以项目许可证为准。</p>
      </section>
      <details className="settings-about-details"><summary>技术与版本信息</summary><dl><dt>产品</dt><dd>{APP_INFO.name}</dd><dt>运行版本</dt><dd>{version ?? "暂不可用"}</dd>
        <dt>运行平台</dt><dd>{platform}</dd><dt>构建框架</dt><dd>Tauri 2 / React</dd><dt>开源许可</dt><dd>{APP_INFO.license}</dd></dl>{copyButton}</details>
      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
    </Card>
  );
}
