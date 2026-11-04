import { Menu } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import type { SvnInfo } from "../../lib/svn";
export function SvnContextMenu({ info, url }: { info?: SvnInfo; url: string | null }) {
  const copy = (value: string) => { void navigator.clipboard.writeText(value).then(() => toast("已复制","success"),() => toast("复制失败，请重试","error")); };
  return <Menu portal width="w-96" trigger={(open,toggle) => <button type="button" className="vc-context-trigger" aria-label="工作副本信息" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="gitBranch" size={13} /><span>{url ? url.split("/").filter(Boolean).slice(-2).join("/") : "识别工作副本…"}</span><Icon name="chevronDown" size={12} /></button>}>
    {() => <div className="vc-context-details"><b>工作副本信息</b><dl><dt>本地目录</dt><dd>{info?.root ?? "尚未识别"}</dd><dt>仓库地址</dt><dd>{url ?? "尚未识别"}</dd><dt>用户名</dt><dd>{info?.user ?? "尚未配置"}</dd><dt>凭据来源</dt><dd>{info?.credentialSource === "saved" ? "工作台保存" : info?.credentialSource === "svn-cache" ? "本机 SVN 缓存" : "未找到可用凭据"}</dd><dt>读取状态</dt><dd>{info ? "已取得本地信息；远端状态在操作时确认" : "正在读取本地信息"}</dd></dl><div className="vc-context-actions"><button type="button" className="vc-btn" disabled={!url} onClick={() => url && copy(url)}>复制仓库地址</button><button type="button" className="vc-btn" disabled={!info?.root} onClick={() => info && copy(info.root)}>复制本地路径</button></div></div>}
  </Menu>;
}
