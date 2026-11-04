import { describe, expect, it } from "vitest";
import { createDirRefresher } from "./dirRefresh";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("createDirRefresher", () => {
  it("并发不超过上限，一轮只 apply 一次", async () => {
    let active = 0;
    let peak = 0;
    const applied: string[][] = [];
    const r = createDirRefresher({
      limit: 4,
      read: async (d) => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        return d.toUpperCase();
      },
      apply: (m) => applied.push([...m.values()]),
    });
    const dirs = Array.from({ length: 300 }, (_, i) => `d${i}`);
    await r.request(dirs);
    expect(peak).toBe(4);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(300);
    expect(applied[0][0]).toBe("D0");
  });

  it("进行中的重复请求合并到下一轮，正在读的目录也会再读", async () => {
    const reads: string[] = [];
    const rounds: string[][] = [];
    const r = createDirRefresher({
      read: async (d) => {
        reads.push(d);
        await tick();
        return d;
      },
      apply: (m) => rounds.push([...m.keys()]),
    });
    const first = r.request(["a", "b"]);
    // 第一轮还在跑：a 已在读，仍要进下一轮；c 重复三次只算一次
    void r.request(["a", "c"]);
    void r.request(["c", "c"]);
    await first;
    expect(rounds).toEqual([["a", "b"], ["a", "c"]]);
    expect(reads).toEqual(["a", "b", "a", "c"]);
  });

  it("空请求不起一轮", async () => {
    let applied = 0;
    const r = createDirRefresher({ read: async (d) => d, apply: () => applied++ });
    await r.request([]);
    expect(applied).toBe(0);
  });
});
