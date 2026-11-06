import { invoke } from "./tauri";
import type { BmfArtifactStatus, BmfGenApply, BmfGenPlan, BmfGenProfile, BmfIssue, BmfTimings } from "./bmf";

export interface GenerationTarget {
  id: string; path: string; family: string; encoding: string;
  generatedSha256: string; targetSha256: string | null; resolvedPath: string;
}
export interface GenerationSnapshot {
  component: string; sourcePath: string; inputSha256: string; profileSha256: string;
  root: string; targets: GenerationTarget[];
}
export interface GenerationCheck {
  snapshot: GenerationSnapshot | null; items: BmfArtifactStatus[]; error: string | null;
  manifest: string | null; timings: BmfTimings;
}
export interface GenerationPreview {
  plan: BmfGenPlan; issues: BmfIssue[]; description: GenerationSnapshot; check: GenerationCheck;
}
export interface GenerationResult extends Omit<BmfGenApply, "items"> {
  root: string; paths: Record<string, string>; failed: number; backups: Record<string, string>; manifestError: string | null;
  items: Array<{ relPath: string; kind: string; status: "written" | "replaced" | "skipped" | "failed"; detail: string }>;
}
export type GenerationPane = "content" | "diff" | "sources";
export type GenerationFilter = "all" | "pending" | "protected";
/** 文档会话只保存输入和导航；产物文本/编辑器模型随生成工具卸载释放。 */
export interface GenerationPreferences {
  profile: BmfGenProfile | null; root: string; selected: string[] | null; overrides: string[];
  activeId: string | null; search: string; filter: GenerationFilter; collapsed: string[];
  pane: GenerationPane; listTop: number; scroll: Record<string, number>;
}
export const newGenerationPreferences = (path: string): GenerationPreferences => ({
  profile: null, root: `${path.replace(/[\\/][^\\/]+$/, "")}\\gen`, selected: null,
  overrides: [], activeId: null, search: "", filter: "all", collapsed: [], pane: "content", listTop: 0, scroll: {},
});

export const generationPreview = (path: string, profile: BmfGenProfile | null, root: string) =>
  invoke<GenerationPreview>("bmf_gen_preview", { path, profile, entities: null, root });
export const generationCheck = (description: GenerationSnapshot, root: string) =>
  invoke<GenerationCheck>("bmf_gen_check", { description, root });
export const generationTarget = (snapshot: GenerationSnapshot, id: string) =>
  invoke<string>("bmf_gen_target", { snapshot, id });
export const generationReveal = (path: string) => invoke<void>("bmf_gen_reveal", { path });
export const generationApply = (path: string, profile: BmfGenProfile, root: string, selected: string[],
  overrides: string[], expected: GenerationSnapshot) =>
  invoke<GenerationResult>("bmf_gen_apply", { path, profile, entities: null, root, selected, overrides, expected, force: false });
