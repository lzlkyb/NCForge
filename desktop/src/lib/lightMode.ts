// 轻量模式：关掉代码智能总开关，jdt.ls 与语义着色一起停。
//
// 不引入第二套「轻量」状态：`lang_enabled` 是唯一真源，后端关开关时会顺手停进程，
// 前端只负责把偏好同步到状态栏并（退出轻量时）把当前模块拉回来。
// 这样设置页、状态栏、命令面板三处入口不会各记一份互相打架的开关。
import { langConfigSet } from "./appConfig";
import { failureText } from "./friendlyError";
import { applyLangPrefs, startLangNow } from "./lang";

export interface LightModeResult {
  ok: boolean;
  error?: string;
}

/**
 * 进入 / 退出轻量模式。
 *
 * 进入：停 jdt.ls（后端 `lang_config_set` 负责），语义着色随之失效——provider 只在
 * 服务就绪时返回 token。退出：如果当前就是 .java，立即拉起，不用等用户再切一次文件。
 */
export async function setLightMode(
  on: boolean,
  activePath: string | null,
): Promise<LightModeResult> {
  try {
    const cfg = await langConfigSet({ lang_enabled: !on });
    applyLangPrefs(cfg);
    if (!on && activePath?.toLowerCase().endsWith(".java")) startLangNow(activePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: failureText("切换轻量模式", e) };
  }
}
