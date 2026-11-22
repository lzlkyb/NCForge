import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteLaunchConfig,
  duplicateLaunchConfig,
  listLaunchConfigs,
  saveLaunchConfig,
  type LaunchConfig,
  type LaunchKind,
} from "../lib/launchConfigs";
import { clearLaunchSelection, launchSelectionStore, selectLaunchConfig } from "../lib/launchConfigSession";
import { useSessionStore } from "../lib/sessionStore";
import { useWorkspaceSelector } from "../lib/workspaceSession";
import { errorToast } from "../lib/errorToast";

/**
 * 启动配置的查询与变更。
 *
 * 查询 key 带工作区根：`launches.json` 按工程存，换工程就是另一份文件，
 * 让缓存自然分开，不需要在切工程时手动失效。无工作区时后端返回空列表
 * （不是错误），所以未打开工程也能安全渲染。
 *
 * 四个命令都返回**全量列表**（后端设计：省掉每次变更后再 list 一次 IPC），
 * 所以变更后直接 `setQueryData` 覆盖，不再 refetch。
 */
export function useLaunchConfigList() {
  const root = useWorkspaceSelector((s) => s.root);
  return useQuery({
    queryKey: ["launch-configs", root ?? null],
    queryFn: listLaunchConfigs,
    staleTime: 10_000,
    retry: false,
  });
}

/** 当前选中的配置对象；id 解析不到（换过工程、配置被删）= 默认，返回 null。 */
export function useSelectedLaunchConfig(kind: LaunchKind): LaunchConfig | null {
  const query = useLaunchConfigList();
  const selection = useSessionStore(launchSelectionStore);
  const id = selection[kind];
  return query.data?.configs.find((c) => c.id === id) ?? null;
}

/**
 * 下拉 + 「保存为配置 / 复制 / 删除」用的全套状态。
 *
 * 换工程时清空选择：旧工程的配置 id 在新工程解析不到，留着会让
 * 「切回来又自动选中」——用户没选过却按旧参数启动。
 */
export function useLaunchConfigs(kind: LaunchKind) {
  const query = useLaunchConfigList();
  const queryClient = useQueryClient();
  const selection = useSessionStore(launchSelectionStore);
  const root = useWorkspaceSelector((s) => s.root);
  const lastRoot = useRef(root);
  useEffect(() => {
    if (lastRoot.current === root) return;
    lastRoot.current = root;
    clearLaunchSelection();
  }, [root]);

  const configs = query.data?.configs.filter((c) => c.target.kind === kind) ?? [];
  const selected = query.data?.configs.find((c) => c.id === selection[kind]) ?? null;
  const select = useCallback((id: string | null) => selectLaunchConfig(kind, id), [kind]);

  /** 变更后返回「新建/更新后的那条配置」，供调用方顺手选中；失败返回 null。 */
  const save = useCallback(
    async (config: LaunchConfig): Promise<LaunchConfig | null> => {
      try {
        const list = await saveLaunchConfig(config);
        queryClient.setQueryData(["launch-configs", root ?? null], list);
        // 后端回传入库后的 id：不再靠前后列表差集（缓存未预热时差集恒真，会选中旧配置）
        return list.configs.find((c) => c.id === list.savedId) ?? null;
      } catch (e) {
        errorToast("保存启动配置", e);
        return null;
      }
    },
    [queryClient, root],
  );

  const duplicate = useCallback(
    async (id: string): Promise<LaunchConfig | null> => {
      try {
        const list = await duplicateLaunchConfig(id);
        queryClient.setQueryData(["launch-configs", root ?? null], list);
        return list.configs.find((c) => c.id === list.savedId) ?? null;
      } catch (e) {
        errorToast("复制启动配置", e);
        return null;
      }
    },
    [queryClient, root],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        const list = await deleteLaunchConfig(id);
        queryClient.setQueryData(["launch-configs", root ?? null], list);
        // 删的是当前选中项时回落默认：留着 id 会让下拉显示空白而实际又不覆盖。
        if (launchSelectionStore.get()[kind] === id) selectLaunchConfig(kind, null);
      } catch (e) {
        errorToast("删除启动配置", e);
      }
    },
    [kind, queryClient, root],
  );

  return { configs, selected, notes: query.data?.notes ?? [], loading: query.isLoading, select, save, duplicate, remove };
}
