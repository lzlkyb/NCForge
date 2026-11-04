import { ConfirmDialog } from "../ui/ConfirmDialog";
import { AuthDialog } from "./AuthDialog";
import { HousekeepingDialog } from "./HousekeepingDialog";
import { friendlySvnError, parseSvnError, svnAuthSet, type ChangeItem, type SvnInfo } from "../../lib/svn";
import { toast } from "../ui/toast";
export type SvnBusy = null | "commit" | "update" | "revert" | "resolve" | "auth";
export interface SvnAuth { open: boolean; error: string | null; }
export function SvnReviewDialogs({ revertTarget, setRevertTarget, onRevert, auth, setAuth, info, busy, setBusy, hkOpen, setHkOpen, refresh }: { revertTarget: ChangeItem | null; setRevertTarget: (target: ChangeItem | null) => void; onRevert: (paths: string[], recursive: boolean) => Promise<void>; auth: SvnAuth; setAuth: (auth: SvnAuth) => void; info: SvnInfo | undefined; busy: SvnBusy; setBusy: (busy: SvnBusy) => void; hkOpen: boolean; setHkOpen: (open: boolean) => void; refresh: () => Promise<unknown> }) {
  return <>
    <ConfirmDialog open={!!revertTarget} variant="destructive" title="撤销本地改动？" confirmLabel="备份并撤销" description={<>恢复 <b>{revertTarget?.rel}</b> 到 BASE 版本。当前文件会先备份，撤销结果提供备份位置。</>} onCancel={() => setRevertTarget(null)} onConfirm={() => { const target = revertTarget; setRevertTarget(null); if (target) void onRevert([target.path],false); }} />
    <AuthDialog open={auth.open} host={info?.host ?? ""} defaultUser={info?.user ?? ""} busy={busy === "auth"} error={auth.error} onClose={() => setAuth({open:false,error:null})} onSubmit={async (user,password) => {
      setBusy("auth");
      try { await svnAuthSet(user,password); setAuth({open:false,error:null}); toast("账号已验证并保存，正在重新扫描","success"); void refresh(); }
      catch (e) { const {code,message} = parseSvnError(e); setAuth({open:true,error:code === "auth" ? message : friendlySvnError(e)}); }
      finally { setBusy(null); }
    }} />
    <HousekeepingDialog open={hkOpen} onClose={() => setHkOpen(false)} onPruned={() => void refresh()} />
  </>;
}
