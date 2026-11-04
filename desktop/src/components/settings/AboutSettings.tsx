import { useAppInfo } from "../../hooks/useAppInfo";
import { APP_INFO, CHANGELOG } from "../../lib/about";
import { invokeOrToast } from "../../lib/tauri";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import "./settings-maintenance.css";

export function AboutSettings({ onOpenHistory }: { onOpenHistory: () => void }) {
  const info = useAppInfo();
  // 壳子的占位地址不能成为看似可用的产品链接，发布配置完整后自然启用。
  const repoConfigured = !/your-name|your-app/.test(APP_INFO.repoUrl);
  const version = info.data?.version;
  return (
    <Card className="settings-maintenance-section">
      <div className="settings-about-brand">
        <img src="/icon.png" width={36} height={36} alt="" />
        <div><h2>{APP_INFO.name}</h2><p>NC65 / NCC 二开的轻量桌面工作台</p></div>
      </div>
      <SettingsRow id="about-version" label="运行版本" keywords={["版本号", "version"]}
        valueText={version ? `v${version}` : info.isError ? "读取失败" : "读取中"}
        sub={info.data?.platform ? `运行平台：${info.data.platform}` : "版本取自当前运行的软件"}
        control={version ? <span className="settings-version">v{version}</span> : info.isError ?
          <Button variant="outline" size="sm" onClick={() => void info.refetch()}>重新读取</Button> : <span className="settings-maintenance-muted">读取中…</span>} />
      <SettingsRow id="about-history" label="更新历史" keywords={["发行说明", "changelog"]}
        sub={CHANGELOG.length ? `已记录 ${CHANGELOG.length} 个版本的改进与修复` : "还没有版本记录"}
        valueText={CHANGELOG.length ? `${CHANGELOG.length} 个版本` : "暂无记录"}
        control={<Button variant="outline" size="sm" onClick={onOpenHistory}>查看更新历史</Button>} />
      <SettingsRow id="about-repo" label="项目仓库" keywords={["源码", "GitHub", "repository"]}
        sub={repoConfigured ? APP_INFO.repoUrl : "项目地址尚未配置"}
        valueText={repoConfigured ? APP_INFO.repoUrl : "未配置"}
        control={<Button variant="outline" size="sm" disabled={!repoConfigured} title={repoConfigured ? "在浏览器中打开项目仓库" : "项目地址尚未配置"}
          onClick={() => void invokeOrToast("open_external", { url: APP_INFO.repoUrl }, "打开仓库链接失败")}>打开仓库</Button>} />
      <SettingsRow id="about-license" label="开源许可" keywords={["协议", "license"]} valueText={APP_INFO.license}
        sub="软件采用的开源许可" last control={<span className="settings-maintenance-muted">{APP_INFO.license}</span>} />
    </Card>
  );
}
