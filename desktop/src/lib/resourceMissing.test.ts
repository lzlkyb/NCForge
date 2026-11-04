import { describe, expect, it } from "vitest";
import { missingResourceId } from "./resourceMissing";

describe("组件缺失识别", () => {
  it.each([
    ["找不到 SVN 组件（ncsvn.jar / svnkit.jar）", "svnkit"],
    ["找不到反编译组件（CFR）", "cfr"],
    ["找不到 Java 编译器组件（ecj）", "ecj"],
    ["找不到可用的 Java 语言服务组件（jdt.ls）", "jdtls"],
  ])("%s 对应 %s", (message, id) => expect(missingResourceId(new Error(message))).toBe(id));
  it.each([null, "SVN 连接失败", "Java 路径不合法", "CFR 超时", "ECJ 编译错误", "jdt.ls 启动超时"])("其他错误不引导重复下载：%s", error => {
    expect(missingResourceId(error)).toBeNull();
  });
});
