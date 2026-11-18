import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ items: [] as unknown[], setDataBreakpoints: vi.fn() }));
vi.mock("./debug", () => ({
  DEBUG_TARGETS: ["server", "client", "remote"],
  debugSetDataBreakpoints: mocks.setDataBreakpoints,
}));
vi.mock("./watchpoints", async () => ({
  ...(await vi.importActual<typeof import("./watchpoints")>("./watchpoints")),
  getWatchpoints: () => mocks.items,
  isWatchpointEnabled: (w: { enabled?: boolean }) => w.enabled !== false,
  subscribeWatchpoints: () => () => {},
}));
import {
  __resetWatchpointSyncForTest,
  applyWatchpointVerified,
  isWatchpointVerified,
  reinstallWatchpoints,
  resetWatchpointSync,
  startWatchpointSync,
  syncWatchpoints,
  watchpointSig,
  watchpointSpecs,
} from "./watchpointSync";

const ok = (list: unknown[]) => ({ breakpoints: list.map(() => ({ verified: true })) });

beforeEach(() => {
  __resetWatchpointSyncForTest();
  mocks.setDataBreakpoints.mockReset();
  mocks.setDataBreakpoints.mockImplementation((_t: string, list: { dataId: string }[]) => ok(list));
  mocks.items = [];
});

describe("watchpointSpecs / watchpointSig", () => {
  it("只下发启用项，条件字段原样带", () => {
    // mock 直接喂 store 的内部清单（真实库存数据已被 normalize 清洗过、无空白）
    mocks.items = [
      { dataId: "A#x", accessType: "read", enabled: true, condition: "x > 0", hitCondition: "3" },
      { dataId: "A#y", accessType: "write", enabled: false },
    ];
    expect(watchpointSpecs()).toEqual([
      { dataId: "A#x", accessType: "read", condition: "x > 0", hitCondition: "3" },
    ]);
    // 签名包含条件：改条件要重发
    const a = watchpointSig(watchpointSpecs());
    mocks.items = [{ dataId: "A#x", accessType: "read", enabled: true, condition: "x > 1" }];
    expect(watchpointSig(watchpointSpecs())).not.toBe(a);
  });
});

describe("syncWatchpoints", () => {
  it("附加后整批下发，verified 按请求顺序回映射", async () => {
    mocks.items = [
      { dataId: "nc.vo.A#x", accessType: "read", enabled: true },
      { dataId: "nc.vo.A#y", accessType: "write", enabled: true },
    ];
    // 第二个装不上：适配器按位回报 false（顺序映射，不是按 dataId 找）
    mocks.setDataBreakpoints.mockResolvedValue({
      breakpoints: [{ verified: true }, { verified: false }],
    });
    startWatchpointSync(() => ["server"]);
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).toHaveBeenCalledTimes(1);
    expect(mocks.setDataBreakpoints).toHaveBeenCalledWith("server", [
      { dataId: "nc.vo.A#x", accessType: "read" },
      { dataId: "nc.vo.A#y", accessType: "write" },
    ]);
    expect(isWatchpointVerified("nc.vo.A#x")).toBe(true);
    expect(isWatchpointVerified("nc.vo.A#y")).toBe(false);
  });

  it("清单没变不重发；变了才重发", async () => {
    mocks.items = [{ dataId: "A#x", accessType: "read", enabled: true }];
    startWatchpointSync(() => ["server"]);
    await syncWatchpoints();
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).toHaveBeenCalledTimes(1);
    mocks.items = [
      { dataId: "A#x", accessType: "read", enabled: true },
      { dataId: "A#z", accessType: "readWrite", enabled: true },
    ];
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).toHaveBeenCalledTimes(2);
    expect(mocks.setDataBreakpoints).toHaveBeenLastCalledWith("server", [
      { dataId: "A#x", accessType: "read" },
      { dataId: "A#z", accessType: "readWrite" },
    ]);
  });

  it("从有到无：发空数组清掉适配器上的观察点", async () => {
    mocks.items = [{ dataId: "A#x", accessType: "read", enabled: true }];
    startWatchpointSync(() => ["server"]);
    await syncWatchpoints();
    mocks.items = [];
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).toHaveBeenLastCalledWith("server", []);
    expect(isWatchpointVerified("A#x")).toBe(false);
  });

  it("从来没发过 + 空清单：不给适配器发无意义的请求", async () => {
    startWatchpointSync(() => ["server"]);
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).not.toHaveBeenCalled();
  });

  it("失败不写签名：下一轮重试", async () => {
    mocks.items = [{ dataId: "A#x", accessType: "read", enabled: true }];
    mocks.setDataBreakpoints.mockRejectedValueOnce(new Error("Empty debug session."));
    startWatchpointSync(() => ["server"]);
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).toHaveBeenCalledTimes(1);
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).toHaveBeenCalledTimes(2);
  });

  it("没附加的目标不下发", async () => {
    mocks.items = [{ dataId: "A#x", accessType: "read", enabled: true }];
    startWatchpointSync(() => []);
    await syncWatchpoints();
    expect(mocks.setDataBreakpoints).not.toHaveBeenCalled();
  });
});

describe("reinstallWatchpoints", () => {
  it("热替换后先清空再整批重发（逼适配器重新 install）", async () => {
    mocks.items = [{ dataId: "A#x", accessType: "readWrite", enabled: true }];
    startWatchpointSync(() => ["server"]);
    await syncWatchpoints();
    mocks.setDataBreakpoints.mockClear();
    const n = await reinstallWatchpoints("server");
    expect(n).toBe(1);
    expect(mocks.setDataBreakpoints).toHaveBeenCalledTimes(2);
    expect(mocks.setDataBreakpoints).toHaveBeenNthCalledWith(1, "server", []);
    expect(mocks.setDataBreakpoints).toHaveBeenNthCalledWith(2, "server", [
      { dataId: "A#x", accessType: "readWrite" },
    ]);
    expect(isWatchpointVerified("A#x")).toBe(true);
  });

  it("没附加调试时返回 0 且不碰适配器", async () => {
    startWatchpointSync(() => []);
    expect(await reinstallWatchpoints("server")).toBe(0);
    expect(mocks.setDataBreakpoints).not.toHaveBeenCalled();
  });
});

describe("applyWatchpointVerified", () => {
  it("回报缺数组时全记 false，不残留上一轮的 true", () => {
    applyWatchpointVerified("server", ["A#x"], [{ verified: true }]);
    expect(isWatchpointVerified("A#x")).toBe(true);
    applyWatchpointVerified("server", ["A#x"], undefined);
    expect(isWatchpointVerified("A#x")).toBe(false);
  });

  it("reset 只清指定目标", () => {
    applyWatchpointVerified("server", ["A#x"], [{ verified: true }]);
    applyWatchpointVerified("client", ["A#x"], [{ verified: true }]);
    resetWatchpointSync("server");
    expect(isWatchpointVerified("A#x")).toBe(true); // client 还在
    resetWatchpointSync();
    expect(isWatchpointVerified("A#x")).toBe(false);
  });
});
