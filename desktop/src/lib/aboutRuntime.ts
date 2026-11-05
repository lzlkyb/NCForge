import { APP_INFO } from "./about";

export function displayPlatform(platform?: string): string {
  if (!platform?.trim()) return "平台信息暂不可用";
  return ({ windows: "Windows", macos: "macOS", linux: "Linux" } as Record<string, string>)[platform] ?? platform;
}

/** Copy only public diagnostics, never workspace or connection details. */
export function versionInfoText(version: string, platform?: string): string {
  return `${APP_INFO.name}\n版本：${version}\n平台：${displayPlatform(platform)}\n项目：${APP_INFO.repoUrl}\n许可：${APP_INFO.license}`;
}
