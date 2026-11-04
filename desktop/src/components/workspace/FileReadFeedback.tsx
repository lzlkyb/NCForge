import { useState } from "react";
import { useOperations } from "../../lib/operations";
import { isUnderPath } from "../../lib/treeProjects";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/** 原文件继续可读；读取目标的反馈不替换 Monaco 或打断光标。 */
export function FileReadFeedback({root,onOpen}:{root:string;onOpen:(path:string)=>Promise<unknown>}) {
  const tasks=useOperations();
  const [dismissed,setDismissed]=useState<number|null>(null);
  const reads=tasks.filter(o=>o.key.startsWith("file.open:") && o.path && isUnderPath(o.path,root) || o.key.startsWith("class:") && o.root===root);
  const last=reads[reads.length-1];
  const pending=[...reads].reverse().find(o=>o.endedAt===undefined && o.visible);
  const item=pending??(last?.state==="failed"?last:undefined);
  if(!item || item.id===dismissed) return null;
  return <div className="wb-read-feedback" role={item.state==="failed"?"alert":"status"}>
    <Icon name={item.state==="failed"?"alertTriangle":"spinner"} size={13} className={item.state==="failed"?"":"animate-spin"}/>
    <span>{item.state==="failed"?`${item.label}失败，请重试或查看运行任务`:`${item.label}…`}</span>
    {item.state==="failed" && <Button size="sm" variant="outline" onClick={()=>void onOpen((item.path??item.scope)!)}>重新读取</Button>}
    <Button size="icon" variant="ghost" aria-label="关闭读取提示" onClick={()=>setDismissed(item.id)}><Icon name="close" size={12}/></Button>
  </div>;
}
