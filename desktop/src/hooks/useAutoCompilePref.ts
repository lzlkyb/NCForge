/**
 * 「保存时自动编译」这个开关的读 / 写 / 失败回滚。
 *
 * 从 `TaskSettings` 里搬出来的（组件体量门禁规则 7）。不用 react-query：整个应用
 * 只有这一页读这个值，为它把页面拴在 QueryClientProvider 上不划算（测试也得跟着
 * 起一个 provider）。
 *
 * 两条不可退让的约定：
 * - 读失败保持 `null`（未知），**不能**兜底成 `true`——那会把「没读到」显示成「已开启」，
 *   与实际状态相反，用户会以为开关坏了。
 * - 写回是乐观更新 + 失败回滚，并且必须同步更新 `rememberAutoCompile` 的进程内缓存：
 *   保存流程读的是那份缓存，不更新要等重启才生效。
 */
import { useEffect, useState } from "react";
import { getConfig, patchConfig, rememberAutoCompile } from "../lib/appConfig";
import { failureText } from "../lib/friendlyError";
import { errorToast } from "../lib/errorToast";

export function useAutoCompilePref() {
  const [value, setValue] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    getConfig()
      .then((c) => alive && setValue(c.auto_compile))
      .catch((e) => { if (alive) { setValue(null); setError(failureText("读取自动编译设置", e)); } });
    return () => {
      alive = false;
    };
  }, [retryToken]);

  const save = async (next: boolean) => {
    setValue(next);
    rememberAutoCompile(next);
    try {
      await patchConfig({ auto_compile: next });
    } catch (e) {
      setValue(!next);
      rememberAutoCompile(!next);
      errorToast("保存自动编译设置", e);
    }
  };

  return { value, error, save, retry: () => setRetryToken((n) => n + 1) };
}
