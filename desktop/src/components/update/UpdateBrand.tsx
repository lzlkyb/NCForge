import { APP_INFO } from "../../lib/about";
import { Icon } from "../ui/icon";

export function UpdateBrand({ currentVersion, version, ready }: {
  currentVersion?: string; version?: string; ready: boolean;
}) {
  const number = version?.replace(/^v/, "") ?? "";
  return <aside className="update-brand" aria-label="升级版本">
    <span className="update-brand-name">{APP_INFO.name}</span>
    <img src="/icon.png" alt="" />
    <div className="update-version-origin">
      {currentVersion && <><span>v{currentVersion.replace(/^v/, "")}</span><Icon name="arrowRight" size={14} aria-hidden="true" /></>}
      <span>{number ? "升级至" : "软件更新"}</span>
    </div>
    <strong className="update-hero-version" data-long={number.length > 8 || undefined} title={number ? `v${number}` : "软件更新"}>
      {number ? <><span>v</span>{number}</> : APP_INFO.name}
    </strong>
    <p className="update-brand-caption">更顺手地，<br />完成日常开发。</p>
    <div className="update-brand-bottom">软件更新<br />{ready ? "更新包已验证 · 等你确认" : "保存工作后，再安装更新"}</div>
  </aside>;
}
