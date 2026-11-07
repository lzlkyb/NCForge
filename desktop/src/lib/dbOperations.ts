import type { OperationSpec } from "./operations";

export const dbTxKey = (connId: string | null, slot?: string | null) => `tx:${connId ?? ""}:${slot || "primary"}`;
import { activateTab, connOf, tabOf } from "./dbStore";
import { toast } from "../components/ui/toast";

/** 任务中心只记连接/会话与数量，SQL、绑定值、口令和原始数据库错误留在来源页面。 */
export function dbTaskSpec(key:string,label:string,connId:string|null,session="主会话",name?:string,tabId?:string):OperationSpec {
  return {key:`db.${key}`,label,page:"db",scope:`${name || (connId ? connOf(connId)?.name : null) || connId || "工程默认连接"} · ${session}`,reveal:tabId ? ()=>{if(tabOf(tabId)) activateTab(tabId);else toast("来源标签已关闭，请在数据库页重新打开", "info");} : undefined,errorDetail:()=>"操作失败，返回数据库页查看详细错误"};
}
export const dbCancelled=(error:unknown)=>/ORA-01013|(?:^|[|:])cancel(?:led)?(?:[|:]|$)/i.test(String(error));
