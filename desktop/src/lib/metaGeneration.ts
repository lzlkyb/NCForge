import type { BmfArtifact, BmfArtifactStatus, BmfDetail, BmfGenPlan } from "./bmf";
import type { GenerationFilter, GenerationPreferences } from "./bmfGeneration";
import type { MetaSelection } from "./metaEditor";

export const GENERATION_FAMILIES: Record<string, string> = { java: "Java", db: "数据库脚本", bill: "单据资源", format: "打印与格式", meta: "注册建议清单", orphan: "旧产物" };
export const GENERATION_STATUSES: Record<string, string> = { new: "新建", unchanged: "已一致", outdated: "待更新", modified: "已手改", conflict: "冲突", orphan: "旧产物" };
export const protectedArtifact = (status?: BmfArtifactStatus) => status?.status === "modified" || status?.status === "conflict";
export const generationPath = (root: string, path: string) => `${root.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;

export function reconcileGeneration(plan: BmfGenPlan, prefs: GenerationPreferences, previous?: BmfGenPlan | null): Partial<GenerationPreferences> {
  const ids = new Set(plan.artifacts.map((a) => a.id));
  const selected = prefs.selected === null ? plan.artifacts.filter((a) => a.kind !== "registry").map((a) => a.id) : prefs.selected.filter((id) => ids.has(id));
  if (previous && prefs.selected !== null) {
    const old = new Set(previous.artifacts.map((a) => a.id));
    selected.push(...plan.artifacts.filter((a) => !old.has(a.id) && a.kind !== "registry").map((a) => a.id));
  }
  return { selected, overrides: prefs.overrides.filter((id) => ids.has(id)), activeId: prefs.activeId && ids.has(prefs.activeId) ? prefs.activeId : plan.artifacts[0]?.id ?? null };
}
export function generationCounts(plan: BmfGenPlan | null, statuses: Record<string, BmfArtifactStatus>, selected: string[], overrides: string[]) {
  const counts = { selected: 0, create: 0, update: 0, keep: 0, same: 0, unknown: 0 };
  const chosen = new Set(selected), force = new Set(overrides);
  for (const a of plan?.artifacts ?? []) {
    if (!chosen.has(a.id)) continue;
    counts.selected++;
    const status = statuses[a.id]?.status;
    if (!status) counts.unknown++;
    else if (status === "new") counts.create++;
    else if (status === "outdated" || (protectedArtifact(statuses[a.id]) && force.has(a.id))) counts.update++;
    else if (status === "unchanged") counts.same++;
    else counts.keep++;
  }
  return counts;
}
export function filteredGeneration(items: BmfArtifact[], statuses: Record<string, BmfArtifactStatus>, search: string, filter: GenerationFilter) {
  const query = search.trim().toLocaleLowerCase();
  return items.filter((a) => (!query || `${a.name} ${a.pathHint}`.toLocaleLowerCase().includes(query))
    && (filter === "all" || (filter === "protected" ? protectedArtifact(statuses[a.id]) : ["new", "outdated"].includes(statuses[a.id]?.status ?? ""))));
}
export function generationSource(detail: BmfDetail | undefined, id: string): { label: string; selection: MetaSelection } | null {
  if (!detail) return null;
  for (const entity of detail.entities) {
    if (entity.id === id) return { label: entity.displayName || entity.name, selection: { kind: "entity", entityId: id } };
    const attr = entity.attrs.find((a) => a.id === id);
    if (attr) return { label: `${entity.displayName || entity.name} · ${attr.displayName || attr.name}`, selection: { kind: "attr", entityId: entity.id, attrId: id } };
  }
  const en = detail.enums.find((e) => e.id === id);
  if (en) return { label: en.displayName || en.name, selection: { kind: "enum", enumId: id } };
  const relation = detail.relations.find((r) => r.id === id);
  if (relation) return { label: relation.name || id, selection: { kind: "relation", relationId: id } };
  const itf = detail.interfaces?.find((i) => i.id === id);
  return itf ? { label: itf.displayName || itf.name, selection: { kind: "interface", interfaceId: id } } : null;
}
