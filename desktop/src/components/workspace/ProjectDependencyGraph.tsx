import type { ProjectToolsContext } from "../../lib/projectWorkbench";
export function ProjectDependencyGraph({context}:{context:ProjectToolsContext}){
  const nodes=context.projects.slice(0,60),byDepth=new Map<number,number>();
  const positions=new Map(nodes.map(node=>{const index=byDepth.get(node.depth)??0;byDepth.set(node.depth,index+1);return[node.name,{x:20+node.depth*230,y:20+index*76}];}));
  const width=Math.max(460,...[...positions.values()].map(p=>p.x+210)),height=Math.max(120,...[...positions.values()].map(p=>p.y+64));
  return <div className="space-y-2"><div className="max-h-64 overflow-auto rounded-[var(--r-control)] border border-border bg-background/70"><svg width={width} height={height} aria-label="工程依赖关系图" role="img">
    <defs><marker id="project-dependency-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="currentColor"/></marker></defs>
    <g className="text-muted-foreground">{context.edges.map((edge,i)=>{const from=positions.get(edge.from),to=positions.get(edge.to);return from&&to?<path key={i} d={`M ${from.x+190} ${from.y+23} C ${from.x+215} ${from.y+23} ${to.x-25} ${to.y+23} ${to.x} ${to.y+23}`} stroke="currentColor" fill="none" strokeDasharray={edge.exported?undefined:"4 3"} markerEnd="url(#project-dependency-arrow)"/>:null;})}</g>
    {nodes.map(node=>{const p=positions.get(node.name)!;return <g key={node.name} transform={`translate(${p.x},${p.y})`}><rect width="190" height="46" rx="6" className={node.disabled?"fill-muted stroke-border":"fill-card stroke-border"}/><text x="10" y="20" className="fill-foreground text-xs">{node.name.length>24?`${node.name.slice(0,23)}…`:node.name}</text><text x="10" y="36" className="fill-muted-foreground text-[10px]">{!node.root?"缺失工程":node.disabled?"已停用":node.origin==="primary"?"当前工程":"依赖工程"}</text></g>;})}
  </svg></div><p className="text-xs text-muted-foreground">箭头来自各工程 .classpath；实线表示导出依赖，虚线表示普通依赖。{context.projects.length>60?"图中显示前 60 个工程，完整关系见下方清单。":""}</p>
  <details className="text-xs"><summary>完整依赖关系（{context.edges.length} 条）</summary><div className="max-h-40 overflow-auto">{context.edges.map((edge,i)=><div key={i}>{edge.from} → {edge.to}{edge.exported?" · 导出":""}</div>)}{!context.edges.length&&<p>未声明工程引用；不会按目录深度推测依赖。</p>}</div></details></div>;
}

