// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLaunchConfigs, useSelectedLaunchConfig } from "./useLaunchConfigs";
import { clearLaunchSelection, launchSelectionStore } from "../lib/launchConfigSession";
import type { LaunchConfig, LaunchConfigList } from "../lib/launchConfigs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(), save: vi.fn(), remove: vi.fn(), duplicate: vi.fn(),
  root: "D:/ws", toast: vi.fn(),
}));

vi.mock("../lib/launchConfigs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/launchConfigs")>()),
  listLaunchConfigs: mocks.list,
  saveLaunchConfig: mocks.save,
  deleteLaunchConfig: mocks.remove,
  duplicateLaunchConfig: mocks.duplicate,
}));
vi.mock("../lib/workspaceSession", () => ({
  useWorkspaceSelector: (selector: (s: { root: string }) => unknown) => selector({ root: mocks.root }),
}));
vi.mock("../lib/errorToast", () => ({ errorToast: mocks.toast }));

const oldConfig: LaunchConfig = { id: "lc-old", name: "日常", target: { kind: "middleware", heapMb: 2048, hotwebs: null, debug: false } };
const created: LaunchConfig = { id: "lc-new", name: "大堆", target: { kind: "middleware", heapMb: 8192, hotwebs: null, debug: false } };
const listOf = (configs: LaunchConfig[], savedId: string | null = null): LaunchConfigList => ({ configs, notes: [], savedId });

let host: HTMLDivElement, root: Root, client: QueryClient;
let api: ReturnType<typeof useLaunchConfigs>;
let selected: ReturnType<typeof useSelectedLaunchConfig>;
let currentRoot = "D:/ws";

/** 把 hook 的返回值捞到外面；`currentRoot` 变了就重渲染一次，模拟切工程。 */
function Probe() {
  mocks.root = currentRoot;
  api = useLaunchConfigs("middleware");
  selected = useSelectedLaunchConfig("middleware");
  return null;
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLaunchSelection();
  currentRoot = "D:/ws";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.list.mockResolvedValue(listOf([]));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearLaunchSelection();
});

describe("启动配置的选中与变更", () => {
  /*
   * 回归钉：旧实现靠「前后列表 id 差集」找新建项。面板刚打开时列表查询还在路上，
   * `getQueryData` 是 undefined → 前列表是空集 → 差集恒真 → 选中列表里第一条旧配置。
   * 现在用后端回的 savedId，与缓存状态无关。
   */
  it("缓存还没预热时也选中新建的那条", async () => {
    mocks.list.mockReturnValue(new Promise<LaunchConfigList>(() => {})); // 列表查询永不返回
    await mount();
    mocks.save.mockResolvedValue(listOf([oldConfig, created], created.id));
    let got: LaunchConfig | null = null;
    await act(async () => { got = await api.save({ id: "", name: "大堆", target: created.target }); });
    expect(got).not.toBeNull();
    expect(got!.id).toBe("lc-new");
  });

  /*
   * 只钉「缓存被换成后端返回的那份」：再往下钉「组件已重渲染」是 react-query 的职责，
   * 在不同并行度下 observer 通知的时序不一致（实测单文件跑绿、四文件并行跑红），
   * 那种断言只会换来抖动，不会换来保护。
   */
  it("保存后用后端返回的全量列表覆盖缓存，不触发 refetch", async () => {
    mocks.list.mockResolvedValue(listOf([oldConfig]));
    await mount();
    mocks.save.mockResolvedValue(listOf([oldConfig, created], created.id));
    await act(async () => { await api.save({ id: "", name: "大堆", target: created.target }); });
    expect(client.getQueryData<LaunchConfigList>(["launch-configs", "D:/ws"])?.configs.map((c) => c.id)).toEqual(["lc-old", "lc-new"]);
    expect(mocks.list).toHaveBeenCalledTimes(1); // 挂载时那一次，之后不再 list
  });

  it("复制后返回副本，不靠差集认 id", async () => {
    mocks.list.mockResolvedValue(listOf([oldConfig]));
    await mount();
    mocks.duplicate.mockResolvedValue(listOf([oldConfig, created], created.id));
    let got: LaunchConfig | null = null;
    await act(async () => { got = await api.duplicate("lc-old"); });
    expect(got!.id).toBe("lc-new");
  });

  it("删掉当前选中的配置时回落默认", async () => {
    mocks.list.mockResolvedValue(listOf([oldConfig]));
    await mount();
    act(() => api.select("lc-old"));
    expect(launchSelectionStore.get().middleware).toBe("lc-old");
    mocks.remove.mockResolvedValue(listOf([]));
    await act(async () => { await api.remove("lc-old"); });
    expect(launchSelectionStore.get().middleware).toBeNull();
  });

  it("切换工程清空选择，避免旧 id 在新工程里失效却仍显示为选中", async () => {
    mocks.list.mockResolvedValue(listOf([oldConfig]));
    await mount();
    act(() => api.select("lc-old"));
    currentRoot = "D:/ws2";
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    });
    expect(launchSelectionStore.get().middleware).toBeNull();
  });

  it("选中 id 在列表里解析不到时回落默认", async () => {
    mocks.list.mockResolvedValue(listOf([oldConfig]));
    await mount();
    act(() => api.select("lc-gone"));
    expect(selected).toBeNull();
    act(() => api.select("lc-old"));
    expect(selected).toMatchObject({ id: "lc-old" });
  });

  it("保存失败不上抛，只提示并返回 null", async () => {
    mocks.list.mockResolvedValue(listOf([oldConfig]));
    await mount();
    mocks.save.mockRejectedValue(new Error("磁盘只读"));
    let got: LaunchConfig | null = created;
    await act(async () => { got = await api.save({ id: "", name: "大堆", target: created.target }); });
    expect(got).toBeNull();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});
