import type { BmfArtifactStatusKind, BmfGenPlan } from "../lib/bmf";
import type { GenerationPreview, GenerationCheck, GenerationResult, GenerationSnapshot } from "../lib/bmfGeneration";
import { generationPath } from "../lib/metaGeneration";
import { metaGenerationPlan } from "./metaGenerationFixture";

export const generationFixture = (root: string, plan: BmfGenPlan = metaGenerationPlan,
  statuses: Record<string, BmfArtifactStatusKind> = {}, path = "D:/workspace/METADATA/demo.bmf"): GenerationPreview => {
  const description: GenerationSnapshot = { component: "demo", sourcePath: path, inputSha256: plan.inputSha256,
    profileSha256: JSON.stringify(plan.profile), root: "", targets: plan.artifacts.map((a) => ({ id: a.id, path: a.pathHint, family: a.family,
      encoding: a.encoding, generatedSha256: a.sha256, targetSha256: null, resolvedPath: "" })) };
  const check: GenerationCheck = { snapshot: { ...description, root, targets: description.targets.map((a) => ({ ...a, resolvedPath: generationPath(root, a.path), targetSha256: statuses[a.id] && statuses[a.id] !== "new" ? "original-sha" : null })) },
    items: plan.artifacts.map((a) => ({ id: a.id, path: a.pathHint, family: a.family, status: statuses[a.id] ?? "new", detail: statuses[a.id] === "modified" ? "生成后被手改，默认保留原文件" : "目录已检查" })),
    error: null, manifest: null, timings: plan.timings };
  return { plan, issues: [], description, check };
};
export const generationResult = (root: string, plan = metaGenerationPlan): GenerationResult => ({
  root, paths: Object.fromEntries(plan.artifacts.map((a) => [a.pathHint, generationPath(root, a.pathHint)])),
  written: plan.artifacts.length, skipped: 0, failed: 0, backups: {}, manifestError: null,
  manifest: "D:/config/generation/demo.json", items: plan.artifacts.map((a) => ({ relPath: a.pathHint, kind: a.kind, status: "written", detail: "已创建" })), timings: plan.timings,
});
