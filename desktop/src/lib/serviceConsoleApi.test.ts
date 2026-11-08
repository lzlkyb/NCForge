import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { serviceLogClear, serviceLogExport, serviceLogExportText, serviceLogPurge, serviceLogRead, serviceLogTail } from "./serviceConsoleApi";
import { clearCompletedOperations, getOperations } from "./operations";
beforeEach(() => { mocks.invoke.mockReset(); mocks.listen.mockReset(); mocks.unlisten.mockReset(); mocks.listen.mockResolvedValue(mocks.unlisten); clearCompletedOperations(); });
afterEach(() => vi.restoreAllMocks());
describe("控制台日志读取与原生导出合约", () => {
  it("读取只传固定来源、历史标识与字节范围，不接受任意路径", async () => {
    await serviceLogRead("middleware", false, 1024, "file-one"); await serviceLogTail("client", true, 2048, "file-two"); await serviceLogClear("client");
    expect(mocks.invoke.mock.calls).toEqual([["service_log_read",{target:"middleware",previous:false,offset:1024,fileId:"file-one"}],["service_log_tail",{target:"client",previous:true,before:2048,fileId:"file-two"}],["service_log_clear",{target:"client"}]]);
  });
  it("清屏与清除日志是两个命令：前者只推视图位，后者带归档意图且不收路径", async () => {
    mocks.invoke.mockResolvedValue({bytes:12,archiveBytes:34});
    expect(await serviceLogPurge("middleware", false)).toEqual({bytes:12,archiveBytes:34});
    await serviceLogPurge("client", true);
    expect(mocks.invoke.mock.calls).toEqual([["service_log_purge",{target:"middleware",archive:false}],["service_log_purge",{target:"client",archive:true}]]);
    // 日志位置由后端从 config_dir 拼，前端连路径参数都不该存在
    for (const [, args] of mocks.invoke.mock.calls) expect(Object.keys(args as object).sort()).toEqual(["archive","target"]);
  });
  it("全文导出不把原文传入IPC，匹配导出明确传有限文本", async () => {
    mocks.invoke.mockResolvedValue({path:"D:/日志.log",bytes:6,canceled:false,ms:2});
    await serviceLogExport("middleware", false, "file-one");
    expect(mocks.invoke.mock.calls[0]).toMatchObject(["service_log_export",{target:"middleware",previous:false,fileId:"file-one",text:null}]);
    await serviceLogExportText("client", true, "已加载原文\n");
    expect(mocks.invoke.mock.calls[1]).toMatchObject(["service_log_export",{target:"client",previous:true,text:"已加载原文\n"}]); expect(mocks.unlisten).toHaveBeenCalledTimes(2);
  });
  it("预先取消不打开选择器，进行中的取消按任务身份请求并清理监听", async () => {
    const before = new AbortController(); before.abort(); expect(await serviceLogExport("client",false,undefined,before.signal)).toBeNull(); expect(mocks.invoke).not.toHaveBeenCalled();
    let resolve!:(v:null)=>void;
    mocks.invoke.mockImplementation(async cmd => cmd === "service_log_export" ? new Promise<null>(yes=>{resolve=yes;}) : undefined);
    const controller = new AbortController(); const promise = serviceLogExport("client",false,undefined,controller.signal); await Promise.resolve();
    controller.abort(); const exportCall = mocks.invoke.mock.calls.find(c=>c[0]==="service_log_export")!;
    expect(mocks.invoke).toHaveBeenCalledWith("service_log_cancel_export",{jobId:exportCall[1].jobId}); resolve(null); expect(await promise).toBeNull(); expect(mocks.unlisten).toHaveBeenCalledOnce();
    const operations = getOperations(); expect(operations[operations.length - 1]?.state).toBe("cancelled");
  });
});
