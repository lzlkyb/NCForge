import { useState } from "react";
import { getOperations, subscribeOperations } from "../../lib/operations";
import { useSyncExternalStore } from "react";
import { isUnderPath } from "../../lib/treeProjects";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/** 原文件继续可读；读取目标的反馈不替换 Monaco 或打断光标。 */
export function FileReadFeedback({root,onOpen}:{root:string;onOpen:(path:string)=>Promise<unknown>}) {
  // 记住「关掉的是哪一种提示」：关掉转圈之后这次读取失败了要重新冒出来，
  // 而关掉失败提示就一直安静（以前只按 id 记，两种会被一起压死）。
  const [dismissed,setDismissed]=useState<{id:number;failed:boolean}|null>(null);
  const item=useSyncExternalStore(subscribeOperations,()=>{
    const reads=getOperations().filter(o=>o.key.startsWith("file.open:") && o.path && isUnderPath(o.path,root) || o.key.startsWith("class:") && o.root===root);
    const last=reads[reads.length-1];
    return reads.reverse().find(o=>o.endedAt===undefined && o.visible)??(last?.state==="failed"?last:undefined);
  });
  const failed=item?.state==="failed";
  if(!item || (dismissed?.id===item.id && dismissed.failed===failed)) return null;
  return <div className="wb-read-feedback" role={failed?"alert":"status"}>
    {failed ? <Icon name="alertTriangle" size={13}/> : <span className="op-wait-dot" aria-hidden="true"/>}
    <span className="wb-read-label" title={item.label}>{failed?`${item.label}失败，请重试或查看运行任务`:`${item.label}…`}</span>
    {failed && <Button size="sm" variant="ghost" onClick={()=>void onOpen((item.path??item.scope)!)}>重新读取</Button>}
    <Button size="icon" variant="ghost" aria-label="关闭读取提示" onClick={()=>setDismissed({id:item.id,failed})}><Icon name="close" size={12}/></Button>
  </div>;
}
