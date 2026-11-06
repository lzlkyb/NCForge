import { describe, expect, it } from "vitest";
import { servicePresentation } from "./servicePresentation";
import type { ServerStatus } from "./server";
import type { ClientStatus } from "./client";

const server = { state: "running", port: 80, portAddress: "127.0.0.1", portOwner: { pid: 1, name: "java" }, portOwnedBySelf: true, exitCode: null, reason: null } as ServerStatus;
describe("服务状态依据", () => {
  it("读失败不能把缓存中的运行中展示为已确认运行", () => expect(servicePresentation("middleware", server, true).state).toBe("unknown"));
  it("未读取端点时不伪装成已停止或默认80端口", () => { const view = servicePresentation("middleware", null); expect(view.state).toBe("loading"); expect(view.endpoint).toBe("尚未读取端点"); });
  it("第三方端口占用不会显示服务就绪", () => { const view = servicePresentation("middleware", { ...server, portOwnedBySelf: false }); expect(view.state).toBe("conflict"); expect(view.label).toBe("端口冲突"); });
  it("客户端只说明进程，并显示自己的连接目标", () => { const view = servicePresentation("client", { state: "running", host: "10.0.0.8", port: 8000 } as ClientStatus); expect(view.label).toBe("进程运行中"); expect(view.endpoint).toBe("10.0.0.8:8000"); });
  it("启动准备与停止命令覆盖尚未更新的旧状态", () => { expect(servicePresentation("middleware", server, false, "start").state).toBe("starting"); expect(servicePresentation("middleware", server, false, "stop").state).toBe("stopping"); });
  it("异常退出保留失败语义", () => expect(servicePresentation("middleware", { ...server, state: "stopped", exitCode: 1 }).label).toBe("异常退出"));
});
