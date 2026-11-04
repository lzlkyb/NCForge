import { Icon } from "../ui/icon";
import { acknowledgeSvnUnknown, useSvnDraft } from "../../lib/svnDraft";
export function SvnCommitOutcome({ root, onHistory, onRefresh }: { root: string; onHistory: () => void; onRefresh: () => void }) {
  const draft = useSvnDraft(root);
  if (draft.unknown) return <div className="vc-outcome" role="status" data-tone="warn"><Icon name="alertTriangle" size={14} /><div><b>提交结果待确认</b><p>服务器可能已接收提交。先查看历史并核实文件，确认前不会再次提交。</p><div className="vc-outcome-actions"><button type="button" className="vc-btn" onClick={onHistory}>查看服务器历史</button><button type="button" className="vc-btn" onClick={() => acknowledgeSvnUnknown(root)}>我已核实，解除待确认</button></div></div></div>;
  if (!draft.lastCommit) return null;
  return <div className="vc-outcome" role="status" data-tone="ok"><Icon name="check" size={14} /><span><b>已提交 r{draft.lastCommit.revision}</b> · {draft.lastCommit.count} 个文件</span><span className="vc-outcome-message" title={draft.lastCommit.message}>{draft.lastCommit.message}</span><span className="vc-sp" /><button type="button" className="vc-chip" onClick={onHistory}>查看历史</button><button type="button" className="vc-chip" onClick={onRefresh}>刷新清单</button></div>;
}
