import { compileCancel } from "./compile";
import { clientStart, clientStatus, clientStop } from "./client";
import { attachDebugger } from "./debugSession";
import { deployApply } from "./deploy";
import { isNcTaskRunning } from "./ncTasks";
import { operationActive } from "./operations";
import { serverStart, serverStatus, serverStop } from "./server";
import { getSession } from "./workspaceSession";
import { sameDevelopmentRoot, type DevelopmentOverrides, type DevelopmentRuntime } from "./developmentFlow";

/** 与既有命令/编译反馈共用运行时，不额外挂载 useModuleCompile 的订阅。 */
export function developmentRuntime(root: string, compileAll?: () => Promise<boolean>, overrides?: DevelopmentOverrides): DevelopmentRuntime {
  let compileOwned = false;
  return {
    root,
    currentRoot: () => getSession().root,
    async status(target) {
      if (target === "client") return clientStatus();
      const s = await serverStatus();
      return { ...s, portConflict: !!s.portOwner && !s.portOwnedBySelf };
    },
    async compile() {
      if (getSession().compiling || isNcTaskRunning()) throw new Error("已有编译或 NC 任务在运行，请等待完成");
      compileOwned = true;
      try {
        // 编译回调必须关闭后端的隐式投送，由本流程的 deploy 选项统一决定。
        if (!compileAll) throw new Error("编译入口尚未就绪，请返回代码页后重试");
        return await compileAll();
      } finally { compileOwned = false; }
    },
    async cancelCompile() {
      if (compileOwned && sameDevelopmentRoot(getSession().root, root)) await compileCancel();
    },
    deploy: deployApply,
    async start(target, debug, requestId) {
      if (operationActive(target === "middleware" ? "service.stop" : "client.stop")) throw new Error("服务正在停止，请等待完成后再开始开发");
      // 覆盖值来自流程开始时的启动配置选择，只在本次启动生效（与抽屉里的启动按钮
      // 同一条路径），不写回全局配置。放工厂闭包而不是 start 参数：executeDevelopmentFlow
      // 不该知道启动配置的存在。
      if (target === "middleware") {
        const own = overrides?.middleware;
        return serverStart(debug, { skipDeploy: true, requestId, heapMb: own?.heapMb, hotwebs: own?.hotwebs });
      }
      return clientStart(debug, { requestId, heapMb: overrides?.client?.heapMb });
    },
    stop: (target, expectedRunId) => target === "middleware" ? serverStop(expectedRunId) : clientStop(expectedRunId),
    attach: (target) => attachDebugger(target === "middleware" ? "server" : "client"),
    requestId: () => crypto.randomUUID(),
  };
}
