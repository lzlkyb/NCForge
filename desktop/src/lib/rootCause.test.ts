import { describe, expect, it } from "vitest";
import { explainError } from "./rootCause";

describe("报错 → 根因", () => {
  it("认 ORA 码并沿用数据字典那套文案", () => {
    const r = explainError("ORA-00904: \"A.B\": 标识符无效");
    expect(r?.kind).toBe("ora");
    expect(r?.cause).toContain("标识符");
  });

  it("连接类错误给的是「去设置」的动作", () => {
    const r = explainError("ORA-12541: TNS: 无监听程序");
    expect(r?.kind).toBe("connection");
    expect(r?.action).toBeTruthy();
  });

  it("编译错误按 ecj 句式认，且带上 NC 语境的动作", () => {
    const r = explainError("UFBoolean cannot be resolved to a type");
    expect(r?.kind).toBe("compile");
    expect(r?.action).toContain("工程关联");
    const m = explainError("The method getPk() is undefined for the type BillVO");
    expect(m?.kind).toBe("compile");
    expect(m?.action).toContain("参数");
  });

  it("NC 业务异常要明说「不是缺陷」", () => {
    const r = explainError("nc.bs.framework.exception.NCLogicException: 单据已审批，不能修改");
    expect(r?.kind).toBe("exception");
    expect(r?.cause).toContain("业务");
  });

  it("同一条消息里既有 ORA 又有空指针时，ORA 才是根因", () => {
    const r = explainError("java.lang.NullPointerException 由 ORA-01722: 无效数字 引起");
    expect(r?.kind).toBe("ora");
  });

  it("认不出就返回 null，不猜", () => {
    expect(explainError("Unknown compiler failure")).toBeNull();
    expect(explainError("   ")).toBeNull();
  });
});
