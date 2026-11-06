import type { BmfGenPlan } from "../lib/bmf";

export const metaGenerationPlan: BmfGenPlan = {
  artifacts: [{ id: "vo", family: "java", kind: "vo", name: "DemoVO.java", pathHint: "java/DemoVO.java", encoding: "UTF-8", eol: "LF", text: "class DemoVO {}", sha256: "file-sha", sourceRefs: [], dependsOn: [] }],
  warnings: [], timings: { parseMs: 1, validateMs: 1, graphMs: 1, renderMs: 1, diffMs: 1, writeMs: 0, totalMs: 4 },
  inputSha256: "input-sha", profileSha256: "profile-sha",
  profile: { style: "traditional", dialect: "oracle", basePackage: "", publicSrcRoot: "src/public", clientSrcRoot: "src/client", testSrcRoot: "src/test",
    options: { generateAggVo: true, generateEnumVo: true, generateInterfaces: false, generateSelVo: false, generateTest: false, generateDdl: true,
      withForeignKeys: false, onlyExtensionTables: false, ufBooleanToBoolean: false, localization: false } },
};
