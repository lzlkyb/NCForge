import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";

/** 与主窗口共用版本缓存，设置页不另起轮询，也不拿更新历史冒充运行版本。 */
export function useAppInfo() {
  return useQuery({
    queryKey: ["app-status"],
    queryFn: () => invoke<{ version?: string; platform?: string }>("get_app_info"),
    staleTime: 30_000,
    refetchInterval: false,
    retry: false,
  });
}
