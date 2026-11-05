import { expect, it } from "vitest";
import { displayPlatform, versionInfoText } from "./aboutRuntime";
it("平台使用可读名称，未知和缺失信息保留真实状态", () => {
  expect(displayPlatform("windows")).toBe("Windows"); expect(displayPlatform("macos")).toBe("macOS");
  expect(displayPlatform("freebsd")).toBe("freebsd"); expect(displayPlatform()).toBe("平台信息暂不可用");
});
it("版本诊断包含实际版本和公开项，不携带本地或业务信息", () => {
  const text = versionInfoText("9.8.7", "linux");
  expect(text).toContain("版本：9.8.7\n平台：Linux"); expect(text).toContain("https://github.com/lzlkyb/NCForge");
  expect(text).not.toMatch(/workspace|jdbc:|password/);
});
