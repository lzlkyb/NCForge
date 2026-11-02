import { describe, expect, it, vi } from "vitest";
import {
  consumePendingChangelog,
  onOpenChangelogRequest,
  requestOpenChangelog,
} from "./changelogRequest";

describe("更新历史请求通道", () => {
  it("没有订阅者（设置页还没挂载）时先存住，挂载后只取一次", () => {
    consumePendingChangelog(); // 清掉别的用例留下的状态
    requestOpenChangelog();
    expect(consumePendingChangelog()).toBe(true);
    expect(consumePendingChangelog()).toBe(false);
  });

  it("设置页已挂载时立即派发，不留下待取请求", () => {
    consumePendingChangelog();
    const cb = vi.fn();
    const off = onOpenChangelogRequest(cb);
    requestOpenChangelog();
    expect(cb).toHaveBeenCalledOnce();
    expect(consumePendingChangelog()).toBe(false);
    off();
  });
});
