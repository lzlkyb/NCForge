import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  composeNote,
  countFilters,
  filterItems,
  groupByModule,
  hasProblem,
  layerText,
  pairState,
  previewZipName,
  sectionLabel,
  selectablePaths,
  selectionStats,
  statsLine,
  ymd,
  type PatchItem,
} from "./patch";

/**
 * 补丁页的纯函数。
 *
 * 这里每一条都直接影响「用户以为会打成什么」：配对状态算错 → 把过期的 class 当成好的
 * 打进包；勾选统计算错 → 底部写着「13 个 class」而包里只有 10 个；
 * 包名规则与后端不一致 → 预览叫 A、实际生成叫 B。
 */

function item(p: Partial<PatchItem> = {}): PatchItem {
  return {
    path: "D:/ws/ic/private/nc/bs/ic/eye/A.java",
    rel: "ic/private/nc/bs/ic/eye/A.java",
    label: "ic/private/nc/bs/ic/eye/A.java",
    module: "ic",
    section: "private",
    pkgRel: "nc/bs/ic/eye",
    target: "replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye",
    layer: { hyext: true, why: "hyext（默认模块 ic,不查 jar）" },
    classes: [{ name: "A.class", path: "D:/ws/out/A.class", fresh: true }],
    problems: [],
    blocked: false,
    outRootUsed: "out",
    ...p,
  };
}

describe("ymd / previewZipName", () => {
  it("用本地日期，不是 UTC", () => {
    // 2026-10-28 00:30 本地：UTC 会算成 10-27，包名就会差一天
    expect(ymd(new Date(2026, 9, 28, 0, 30))).toBe("20261028");
    expect(ymd(new Date(2026, 0, 1, 23, 59))).toBe("20260101");
  });

  it("与后端同一套换字符规则", () => {
    expect(previewZipName("库存借出借入跨组织改造", "20261028")).toBe(
      "库存借出借入跨组织改造_20261028.zip",
    );
    expect(previewZipName("a/b:c*d", "20261028")).toBe("a_b_c_d_20261028.zip");
  });

  it("描述为空时回落到「补丁」，与后端 zip_file_name 一致", () => {
    expect(previewZipName("   ", "20261028")).toBe("补丁_20261028.zip");
  });
});

describe("pairState", () => {
  it("有 class 且都比 java 新 → ok，显示个数", () => {
    const s = pairState(
      item({
        classes: [
          { name: "A.class", path: "", fresh: true },
          { name: "A$1.class", path: "", fresh: true },
        ],
      }),
    );
    expect(s.kind).toBe("ok");
    expect(s.text).toBe("2 class");
  });

  it("没有 class → 未编译（打进去是空目录）", () => {
    const s = pairState(item({ classes: [] }));
    expect(s.kind).toBe("miss");
    expect(s.text).toBe("未编译");
  });

  it("只要有一个 class 比 java 旧 → 过期，且点名是哪个", () => {
    const s = pairState(
      item({
        classes: [
          { name: "A.class", path: "", fresh: true },
          { name: "A$1.class", path: "", fresh: false },
        ],
      }),
    );
    expect(s.kind).toBe("old");
    expect(s.title.endsWith("A$1.class")).toBe(true);
  });

  it("upm 与网页是整文件替换，不看编译产物", () => {
    expect(pairState(item({ section: "upm", classes: [] })).text).toBe("整文件");
    expect(pairState(item({ section: "hotwebs", classes: [] })).text).toBe("整文件");
  });
});

describe("layerText / sectionLabel", () => {
  it("upm 与网页不看层判定，直接按类型显示", () => {
    expect(layerText(item({ section: "upm" }))).toBe("upm");
    expect(layerText(item({ section: "hotwebs" }))).toBe("网页");
    expect(layerText(item({ layer: null }))).toBe("标准");
    expect(layerText(item({ layer: { hyext: false, why: "标准层" } }))).toBe("标准");
    expect(layerText(item())).toBe("hyext");
  });

  it("段名说人话", () => {
    expect(sectionLabel("private")).toBe("private 段");
    expect(sectionLabel("hotwebs")).toBe("网页");
  });
});

describe("groupByModule / filterItems / countFilters", () => {
  const a = item({ path: "a", module: "ic" });
  const b = item({ path: "b", module: "ic", label: "ic/public/nc/itf/B.java" });
  const c = item({ path: "c", module: "uapbd", section: "public", label: "uapbd/public/X.java" });
  const web = item({ path: "w", module: "hotwebs", section: "hotwebs", label: "eyeportal/order.jsp" });
  const items = [a, b, c, web];

  it("按模块连续分组，不重排", () => {
    const g = groupByModule(items);
    expect(g.map((x) => x.module)).toEqual(["ic", "uapbd", "hotwebs"]);
    expect(g[0].items).toHaveLength(2);
  });

  it("搜索同时匹配文件名与包路径", () => {
    expect(filterItems(items, new Set(), "order", "all")).toEqual([web]);
    expect(filterItems(items, new Set(), "nc/itf", "all")).toEqual([b]);
    expect(filterItems(items, new Set(), "", "all")).toHaveLength(4);
  });

  it("chip：已勾 / 有问题 / 其它", () => {
    const broken = item({ path: "x", problems: [{ level: "warn", text: "class 过期" }] });
    const all = [...items, broken];
    expect(filterItems(all, new Set(["a"]), "", "picked")).toEqual([a]);
    expect(filterItems(all, new Set(), "", "problem")).toEqual([broken]);
    expect(filterItems(all, new Set(), "", "other").map((i) => i.path)).toEqual(["w"]);
  });

  it("计数：picked 只数真正在集合里的", () => {
    const counts = countFilters(items, new Set(["a", "c"]));
    expect(counts).toEqual({ all: 4, picked: 2, problem: 0, other: 1 });
  });

  it("blocked 也算「有问题」——勾了也打不进包", () => {
    expect(hasProblem(item({ blocked: true }))).toBe(true);
    expect(hasProblem(item())).toBe(false);
  });
});

describe("selectablePaths / selectionStats", () => {
  const good = item({ path: "a" });
  const blocked = item({ path: "b", blocked: true });
  const stale = item({
    path: "c",
    classes: [{ name: "C.class", path: "", fresh: false }],
  });
  const items = [good, blocked, stale];

  it("有 error 的项不允许勾", () => {
    expect(selectablePaths(items)).toEqual(["a", "c"]);
  });

  it("统计里 blocked 单独算，risky 只数「勾上了但打不进去」的", () => {
    const s = selectionStats(items, new Set(["a", "c"]));
    expect(s.picked).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.risky).toBe(1);
    expect(s.classes).toBe(2);
    expect(s.percent).toBe(67);
  });

  it("空清单不除零", () => {
    expect(selectionStats([], new Set()).percent).toBe(0);
    expect(statsLine(selectionStats(items, new Set(["a"])))).toBe("1 / 3 已勾 · 1 个 class");
  });
});

describe("composeNote", () => {
  it("全空返回空串（让后端自己补标题）", () => {
    expect(composeNote(EMPTY_DRAFT)).toBe("");
    expect(composeNote({ ...EMPTY_DRAFT, 原因: "   " })).toBe("");
  });

  it("只拼写了的节，顺序固定，标题用 ##", () => {
    const note = composeNote({ ...EMPTY_DRAFT, 修改点: "- 加了审批校验", 功能说明: "跨组织借用" });
    expect(note).toBe("## 功能说明\n\n跨组织借用\n\n## 修改点\n\n- 加了审批校验");
  });

  it("多行内容原样保留", () => {
    const note = composeNote({ ...EMPTY_DRAFT, 影响范围: "单据\n回归点\n上线动作" });
    expect(note).toContain("单据\n回归点\n上线动作");
  });
});
