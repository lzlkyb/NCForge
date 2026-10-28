import { describe, expect, it } from "vitest";
import {
  firstLine,
  formatBytes,
  formatRevTime,
  friendlySvnError,
  keyOf,
  letterTone,
  parseSvnError,
  reviewProgress,
  reviewedSet,
  type ChangesView,
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
    expect(letterTone("!")).toBe("del");
    expect(letterTone("C")).toBe("conflict");
    expect(letterTone("?")).toBe("untracked");
    // SVN 还有 G/U/~ 等状态，界面上统一按「未纳管」的灰色处理即可
    expect(letterTone("~")).toBe("untracked");
  });
});

describe("reviewProgress", () => {
  const view = (items: Array<{ path: string; isDir?: boolean }>): ChangesView => ({
    groups: [
      {
        module: "pu",
        items: items.map((i) => ({
          path: i.path,
          rel: i.path.split("/").slice(-1)[0],
          module: "pu",
          letter: "M",
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
