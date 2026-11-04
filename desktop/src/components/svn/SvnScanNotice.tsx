import { Icon } from "../ui/icon";
import { friendlySvnError, parseSvnError } from "../../lib/svn";
import { missingResourceId } from "../../lib/resourceMissing";
import { ResourceDownloadButton } from "../resource/ResourceDownloadButton";
export function SvnScanNotice({ error, onAuth, onRefresh, fetching }: { error: unknown; onAuth: () => void; onRefresh: () => void; fetching: boolean }) {
  if (!error) return null;
  const parsed = parseSvnError(error);
  const missing = missingResourceId(error);
  return <div className="vc-scan-notice"><div className="vc-alert" data-tone="warn"><Icon name="alert" size={14} /><span>{friendlySvnError(error)}</span>{missing && <ResourceDownloadButton id={missing} />}{parsed.code === "auth" && <button type="button" className="vc-btn" onClick={onAuth}>填写账号</button>}<button type="button" className="vc-btn" disabled={fetching} onClick={onRefresh}>{fetching ? "扫描中…" : "重新扫描"}</button></div><details className="vc-raw"><summary>查看原始输出</summary><pre>{String(error)}</pre></details></div>;
}
