import { describe, expect, it } from "vitest";
import {
  firstLine,
  formatBytes,
  formatRevTime,
  formatWhen,
  friendlySvnError,
  keyOf,
  letterTone,
  parseSvnError,
  reviewProgress,
  reviewedSet,
  sortChanges,
  type ChangeGroup,
  type ChangeItem,
  type ChangesView,
  type StatusLetter,
} from "./svn";

/**
 * 版本控制页的纯函数。
 *
 * 这些看着像琐碎的字符串处理，但每一条都直接决定「用户看到的结论对不对」：
 * 状态字母认错 → 把删除当成新增；已审 key 大小写不一致 → 进度永远 0；
 * 错误码拆错 → 该弹账号框的时候只弹一句看不懂的 SVN 报错。
 */

describe("parseSvnError", () => {
  it("拆出已知 code 与消息", () => {
    expect(parseSvnError("auth|服务器要求认证")).toEqual({ code: "auth", message: "服务器要求认证" });
    expect(parseSvnError("conflict|EyeContrWriteRule.java 冲突")).toEqual({
      code: "conflict",
      message: "EyeContrWriteRule.java 冲突",
    });
  });

  it("消息里再出现竖线时只按第一个切", () => {
    expect(parseSvnError("wc|路径 A|B 不存在")).toEqual({ code: "wc", message: "路径 A|B 不存在" });
  });

  it("不认识的 code 整体当消息（不吞字）", () => {
    expect(parseSvnError("boom|炸了")).toEqual({ code: "other", message: "boom|炸了" });
    expect(parseSvnError("没有竖线的错误")).toEqual({ code: "other", message: "没有竖线的错误" });
  });

  it("Error 与未知类型都能转成字符串", () => {
    expect(parseSvnError(new Error("timeout|超时")).code).toBe("timeout");
    expect(parseSvnError(undefined).code).toBe("other");
  });
});

describe("keyOf", () => {
  it("转小写并把反斜杠换成正斜杠（与后端 svn_review::key_of 一致）", () => {
    expect(keyOf("C:\\work\\aier\\newar\\a\\B.java")).toBe("c:/work/aier/newar/a/b.java");
    expect(keyOf("C:/work/A.java")).toBe("c:/work/a.java");
  });
});

describe("letterTone", () => {
  it("把 SVN 状态字母映射到语义色调", () => {
    expect(letterTone("M")).toBe("mod");
    expect(letterTone("R")).toBe("mod");
    expect(letterTone("A")).toBe("add");
    expect(letterTone("D")).toBe("del");
    expect(letterTone("!")).toBe("missing");
    expect(letterTone("C")).toBe("conflict");
    expect(letterTone("?")).toBe("untracked");
    expect(letterTone("~")).toBe("conflict");
    expect(letterTone("G")).toBe("mod");
  });
});

describe("reviewProgress", () => {
  const view = (
    items: Array<{ path: string; isDir?: boolean; letter?: StatusLetter }>,
  ): ChangesView => ({
    groups: [
      {
        module: "pu",
        items: items.map((i) => ({
          path: i.path,
          rel: i.path.split("/").slice(-1)[0],
          module: "pu",
          letter: i.letter ?? "M",
          status: "modified",
          revision: 100,
          isDir: i.isDir ?? false,
          ignored: false,
        })),
      },
    ],
    shown: items.length,
    total: items.length,
    ignored: 0,
  });

  it("只算文件，目录不参与分母", () => {
    const p = reviewProgress(view([{ path: "/a.java" }, { path: "/dir", isDir: true }]), new Set());
    expect(p).toEqual({ done: 0, total: 1, percent: 0 });
  });

  it("冲突与已删除不进球分母：它们没有「标记已审」入口", () => {
    // 算进去的话进度永远到不了 100%，用户没法判断是真没审完还是分母算错
    const p = reviewProgress(
      view([
        { path: "/a.java" },
        { path: "/b.java", letter: "C" },
        { path: "/c.java", letter: "D" },
        { path: "/d.java", letter: "!" },
      ]),
      new Set([keyOf("/a.java")]),
    );
    expect(p).toEqual({ done: 1, total: 1, percent: 100 });
  });

  it("按 keyOf 规则命中已审集合（大小写/斜杠不敏感）", () => {
    const p = reviewProgress(view([{ path: "C:\\w\\A.java" }]), new Set(["c:/w/a.java"]));
    expect(p).toEqual({ done: 1, total: 1, percent: 100 });
  });

  it("空清单时百分比记 0，不产生 NaN", () => {
    expect(reviewProgress(view([]), new Set())).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it("百分比四舍五入", () => {
    const items = [{ path: "/1.java" }, { path: "/2.java" }, { path: "/3.java" }];
    expect(reviewProgress(view(items), new Set([keyOf("/1.java")])).percent).toBe(33);
  });
});

describe("reviewedSet", () => {
  it("没数据时给空集合，不是 undefined", () => {
    expect(reviewedSet(undefined).size).toBe(0);
  });

  it("把后端给的 key 列表原样装进 Set", () => {
    const s = reviewedSet({
      changes: { groups: [], shown: 0, total: 0, ignored: 0 },
      scanned: 0,
      generatedAtMs: 0,
      hasConflict: false,
      reviewed: ["c:/a.java", "c:/b.java"],
      incremental: false,
      modulesScanned: 0,
      epoch: 1,
    });
    expect(s.has("c:/a.java")).toBe(true);
    expect(s.size).toBe(2);
  });
});

describe("formatRevTime", () => {
  it("毫秒时间戳格式化成分钟精度", () => {
    const ms = new Date(2026, 9, 19, 17, 15, 30).getTime();
    expect(formatRevTime(ms)).toBe("2026-10-19 17:15");
  });

  it("0 / 负数 / 缺失给破折号", () => {
    expect(formatRevTime(0)).toBe("—");
    expect(formatRevTime(-1)).toBe("—");
  });
});

describe("firstLine", () => {
  it("取第一行非空内容并去掉首尾空白", () => {
    expect(firstLine("\n\n  修复工单保存  \n第二行")).toBe("修复工单保存");
  });

  it("全空时给空串", () => {
    expect(firstLine("   \n\n")).toBe("");
  });
});

describe("formatBytes", () => {
  it("按量级给 B / KB / MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(10020)).toBe("9.8 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("friendlySvnError", () => {
  it("auth 引导到右上角账号按钮", () => {
    expect(friendlySvnError("auth|Authentication required")).toContain("账号");
  });

  it("wc 说人话：不在版本控制下", () => {
    expect(friendlySvnError("wc|is not a working copy")).toContain("不在 SVN 版本控制下");
  });

  it("其它 code 原样透出后端消息（不丢关键细节）", () => {
    expect(friendlySvnError("other|磁盘满了")).toBe("磁盘满了");
  });
});

describe("sortChanges", () => {
  const item = (rel: string, mtimeMs: number | null, module = "pu"): ChangeItem => ({
    path: `C:/ws/${rel}`,
    rel,
    module,
    letter: "M",
    status: "modified",
    revision: 1,
    isDir: false,
    ignored: false,
    mtimeMs,
  });
  const group = (module: string, items: ChangeItem[]): ChangeGroup => ({ module, items });

  it("path 模式原样返回（后端已按路径排好）", () => {
    const gs = [group("pu", [item("b.java", 200), item("a.java", 100)])];
    expect(sortChanges(gs, "path")).toBe(gs);
  });

  it("mtime 模式组内新的在上", () => {
    const gs = [group("pu", [item("a.java", 100), item("b.java", 300), item("c.java", 200)])];
    expect(sortChanges(gs, "mtime")[0].items.map((i) => i.rel)).toEqual(["b.java", "c.java", "a.java"]);
  });

  it("取不到 mtime 的条目排最后，且不被当成 1970 年排最前", () => {
    const gs = [group("pu", [item("gone.java", null), item("old.java", 100), item("new.java", 900)])];
    expect(sortChanges(gs, "mtime")[0].items.map((i) => i.rel)).toEqual(["new.java", "old.java", "gone.java"]);
  });

  it("同一时刻按路径兜底，顺序稳定", () => {
    const gs = [group("pu", [item("b.java", 500), item("a.java", 500)])];
    expect(sortChanges(gs, "mtime")[0].items.map((i) => i.rel)).toEqual(["a.java", "b.java"]);
  });

  it("模块组按组内最新时间降序", () => {
    const gs = [
      group("pu", [item("x.java", 100)]),
      group("ic", [item("y.java", 900)]),
      group("ap", [item("z.java", 500)]),
    ];
    expect(sortChanges(gs, "mtime").map((g) => g.module)).toEqual(["ic", "ap", "pu"]);
  });

  it("不改传入的数组", () => {
    const gs = [group("pu", [item("a.java", 100), item("b.java", 200)])];
    sortChanges(gs, "mtime");
    expect(gs[0].items.map((i) => i.rel)).toEqual(["a.java", "b.java"]);
  });
});

describe("formatWhen", () => {
  const now = new Date("2026-11-04T14:30:00").getTime();
  const at = (s: string) => new Date(s).getTime();

  it("读不到给破折号", () => {
    expect(formatWhen(null, now)).toBe("—");
    expect(formatWhen(0, now)).toBe("—");
    expect(formatWhen(undefined, now)).toBe("—");
  });

  it("5 分钟内是刚刚", () => {
    expect(formatWhen(at("2026-11-04T14:26:00"), now)).toBe("刚刚");
  });

  it("当天给时刻", () => {
    expect(formatWhen(at("2026-11-04T09:05:00"), now)).toBe("09:05");
  });

  it("昨天与天前", () => {
    expect(formatWhen(at("2026-11-03T23:50:00"), now)).toBe("昨天");
    expect(formatWhen(at("2026-11-03T20:00:00"), now)).toBe("昨天");
    expect(formatWhen(at("2026-11-01T08:00:00"), now)).toBe("3 天前");
  });

  it("更早给月日，跨年带年份", () => {
    expect(formatWhen(at("2026-10-19T17:15:00"), now)).toBe("10-19");
    expect(formatWhen(at("2025-12-30T17:15:00"), now)).toBe("25-12-30");
  });

  it("时钟偏差不出现负数", () => {
    // 文件时间比现在新 2 小时：同一天给时刻，跨天给月日
    expect(formatWhen(at("2026-11-04T16:00:00"), now)).toBe("16:00");
    expect(formatWhen(at("2026-11-06T01:00:00"), now)).toBe("11-06");
  });
});
