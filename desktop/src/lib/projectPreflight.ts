import { getCodeDiags } from "./diagStore";
import { getSession } from "./workspaceSession";
import { readFile } from "./workspace";
import { keyOf } from "./svn";
export function conflictMarkerLines(text:string):number[]{return text.replace(/\r\n/g,"\n").split("\n").flatMap((line,index)=>/^(?:<{7}(?: .*)?|={7}|>{7}(?: .*)?)$/.test(line)?[index+1]:[]);}
const textFile=(path:string)=>/\.(?:java|xml|upm|aop|properties|prefs|classpath|project|sql|json|ya?ml|txt|md)$/i.test(path)||/\/(?:\.classpath|\.project)$/i.test(path.replace(/\\/g,"/"));
/** Only selected, existing text files participate. Deletions and binary artifacts are skipped. */
export async function checkProjectPreflight(paths:string[]):Promise<void>{
  const keys=new Set(paths.map(keyOf)),dirty=new Set(getSession().tabs.filter(t=>t.dirty||t.eolChanged).map(t=>keyOf(t.path)));
  const errors=getCodeDiags().filter(d=>d.severity==="error"&&keys.has(keyOf(d.path))&&!dirty.has(keyOf(d.path)));
  if(errors.length)throw new Error(`提交前检查发现 ${errors.length} 个 Java 错误：${errors[0].path}:${errors[0].line} · ${errors[0].message}；请处理后重新提交`);
  for(const path of paths.filter(textFile)){
    // 读不出来（权限、被独占、后端未返回）不阻断提交：冲突标记只是额外保险，真冲突 SVN 会另行拦住。
    const content=await readFile(path).catch(()=>null),markers=conflictMarkerLines(content?.text??"");
    if(markers.length)throw new Error(`提交前检查发现未解决的冲突标记：${path}:${markers[0]}；请处理后重新提交`);
  }
}
