// @vitest-environment jsdom
/**
 * 远程附加地址的校验与持久化。
 *
 * 校验口径要和 Rust `debug::remote_endpoint` 一致：主机可省略（默认回环），
 * 端口必须有且在 1–65535。两边不一致会出现「前端放行、后端拒绝」的错位。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { loadRemoteInput, parseRemoteInput, saveRemoteInput } from "./debugRemote";

beforeEach(() => {
  localStorage.clear();
});

describe("parseRemoteInput", () => {
  it("缺端口时不允许提交", () => {
    const r = parseRemoteInput("127.0.0.1", "");
    expect(r.endpoint).toBeNull();
    expect(r.error).toContain("端口");
  });

  it("端口必须是 1–65535 的整数", () => {
    expect(parseRemoteInput("127.0.0.1", "0").endpoint).toBeNull();
    expect(parseRemoteInput("127.0.0.1", "65536").endpoint).toBeNull();
    expect(parseRemoteInput("127.0.0.1", "50.5").endpoint).toBeNull();
    expect(parseRemoteInput("127.0.0.1", "abc").endpoint).toBeNull();
    expect(parseRemoteInput("127.0.0.1", "805").endpoint).toEqual({ host: "127.0.0.1", port: 805 });
  });

  it("主机留空按回环处理（SSH 隧道的常见用法）", () => {
    expect(parseRemoteInput("  ", "5005").endpoint).toEqual({ host: "127.0.0.1", port: 5005 });
  });

  it("主机不许含空白，也不许过长", () => {
    expect(parseRemoteInput("dev host", "5005").endpoint).toBeNull();
    expect(parseRemoteInput("a".repeat(254), "5005").endpoint).toBeNull();
  });

  it("合法地址去掉首尾空格后返回", () => {
    expect(parseRemoteInput(" 10.0.0.7 ", " 5005 ").endpoint).toEqual({
      host: "10.0.0.7",
      port: 5005,
    });
  });
});

describe("远程地址持久化", () => {
  it("没存过时给回环 + 空端口，强制确认映射端口", () => {
    expect(loadRemoteInput()).toEqual({ host: "127.0.0.1", port: "" });
  });

  it("保存后能读回，并去掉首尾空格", () => {
    saveRemoteInput({ host: " 127.0.0.1 ", port: " 5005 " });
    expect(loadRemoteInput()).toEqual({ host: "127.0.0.1", port: "5005" });
  });

  it("数据损坏时回落到默认值，不抛错", () => {
    localStorage.setItem("ncforge-debug-remote-endpoint", "{not json");
    expect(loadRemoteInput()).toEqual({ host: "127.0.0.1", port: "" });
  });
});
