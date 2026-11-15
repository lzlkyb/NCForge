import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { useProjectWorkbench,openProjectWorkbench,closeProjectWorkbench,type ProjectPane } from "../../lib/projectWorkbench";
import { ProjectDependenciesPane } from "./ProjectDependenciesPane";
import { ProjectBuildPane } from "./ProjectBuildPane";
import { ProjectShelfPane } from "./ProjectShelfPane";
const panes:{id:ProjectPane;label:string}[]=[{id:"dependencies",label:"依赖与源码"},{id:"build",label:"构建与终端"},{id:"shelf",label:"变更集"}];
export function ProjectWorkbenchHost(){const pane=useProjectWorkbench();if(!pane)return null;
  return <Modal open onClose={closeProjectWorkbench} ariaLabel="工程工具" className="w-full max-w-4xl rounded-[var(--r-dialog)] modal-surface p-5"><div className="mb-3 flex items-center justify-between"><h3 className="text-base font-semibold">工程工具</h3><Button size="sm" variant="outline" onClick={closeProjectWorkbench}>关闭</Button></div><div className="mb-4 flex gap-2" role="tablist" aria-label="工程工具分类">{panes.map(item=><button key={item.id} type="button" role="tab" aria-selected={pane===item.id} className={`rounded-[var(--r-control)] px-3 py-1 text-sm ${pane===item.id?"bg-accent text-accent-foreground":"text-muted-foreground hover:bg-accent"}`} onClick={()=>openProjectWorkbench(item.id)}>{item.label}</button>)}</div><div className="max-h-[70vh] overflow-auto">{pane==="dependencies"?<ProjectDependenciesPane/>:pane==="build"?<ProjectBuildPane/>:<ProjectShelfPane/>}</div></Modal>;
}
