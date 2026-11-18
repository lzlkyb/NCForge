import { describe, expect, it } from "vitest";
import { guessDateFormat, isDateColumn, presetSample } from "./importDate";

describe("日期格式推断", () => {
  it("唯一命中就直接给", () => {
    expect(guessDateFormat(["2026/11/17", "2026/12/01"])).toEqual({ kind: "ok", id: "slash" });
    expect(guessDateFormat(["2026-11-17"])).toEqual({ kind: "ok", id: "iso" });
    expect(guessDateFormat(["20261117"])).toEqual({ kind: "ok", id: "compact" });
    expect(guessDateFormat(["2026年11月17日"])).toEqual({ kind: "ok", id: "cn" });
  });

  it("值域能消歧：25 不可能是月份", () => {
    // 25/12/2026 只可能是日/月；如果这里也报歧义，说明值域校验没生效
    expect(guessDateFormat(["25/12/2026", "01/02/2026"])).toEqual({ kind: "ok", id: "dmy-slash" });
  });

  it("01/02/2026 必须由人选", () => {
    const g = guessDateFormat(["01/02/2026"]);
    expect(g.kind).toBe("ambiguous");
    expect(g.kind === "ambiguous" && g.ids).toEqual(["dmy-slash", "mdy-slash"]);
  });

  it("混进非日期值就退回 none，不硬套", () => {
    expect(guessDateFormat(["2026/11/17", "N/A"])).toEqual({ kind: "none" });
    expect(guessDateFormat(["abc"])).toEqual({ kind: "none" });
    expect(guessDateFormat([])).toEqual({ kind: "none" });
    expect(guessDateFormat(["", "  "])).toEqual({ kind: "none" });
  });

  it("空单元格不参与判定", () => {
    expect(guessDateFormat(["2026/11/17", ""])).toEqual({ kind: "ok", id: "slash" });
  });

  it("带时间的斜杠日期不会被当成纯日期", () => {
    expect(guessDateFormat(["2026/11/17 09:30:00"])).toEqual({ kind: "ok", id: "slash-ts" });
  });

  it("只认日期类型列", () => {
    expect(isDateColumn("DATE")).toBe(true);
    expect(isDateColumn("timestamp(6)")).toBe(true);
    expect(isDateColumn("VARCHAR2")).toBe(false);
    expect(isDateColumn("NUMBER")).toBe(false);
  });

  it("样例文案与键对应", () => {
    expect(presetSample("slash")).toBe("2026/11/17");
    expect(presetSample("nope")).toBeNull();
  });
});
