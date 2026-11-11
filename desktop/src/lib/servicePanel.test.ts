// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { requestServiceRestart, takeServiceRestartRequest } from "./servicePanel";

describe("重启请求带目标", () => {
  it("不带目标时默认重启中间件，取走后清空", () => {
    requestServiceRestart();
    expect(takeServiceRestartRequest()).toBe("middleware");
    expect(takeServiceRestartRequest()).toBeNull();
  });

  it("可以指定重启客户端", () => {
    requestServiceRestart("client");
    expect(takeServiceRestartRequest()).toBe("client");
    expect(takeServiceRestartRequest()).toBeNull();
  });

  it("同时挂了两个请求时以后一个为准", () => {
    requestServiceRestart("middleware");
    requestServiceRestart("client");
    expect(takeServiceRestartRequest()).toBe("client");
  });
});
