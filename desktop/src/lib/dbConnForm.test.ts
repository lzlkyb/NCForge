import { expect, it } from "vitest";
import { initialConnForm, mergeConnForm } from "./dbConnForm";

const blank = () => initialConnForm(null);

it("按主机与服务名重拼 JDBC URL，端口与 SID 写法一并带上", () => {
  const f = mergeConnForm(blank(), { host: "10.200.22.144", port: "1521", service: "orcl" });
  expect(f.url).toBe("jdbc:oracle:thin:@10.200.22.144:1521/orcl");
  // 勾上 SID 写法后重新同步，连接串跟着换分隔符
  expect(mergeConnForm(f, { sid: true }).url).toBe("jdbc:oracle:thin:@10.200.22.144:1521:orcl");
  expect(mergeConnForm(f, { sid: false }).url).toBe("jdbc:oracle:thin:@10.200.22.144:1521/orcl");
});

it("主机或服务名被清空时 URL 一起清空，不留对不上的旧串", () => {
  const f = mergeConnForm(blank(), { host: "h", service: "s" });
  expect(f.url).not.toBe("");
  expect(mergeConnForm(f, { service: "" }).url).toBe("");
});

it("直接改 URL 会反解出主机、端口、服务名与 SID 写法", () => {
  const f = mergeConnForm(blank(), { url: "jdbc:oracle:thin:@db.local:1522/AIER633" });
  expect([f.host, f.port, f.service, f.sid]).toEqual(["db.local", "1522", "AIER633", false]);
});

it("认不出的 URL 只留文本，不把已填的主机端口冲成空", () => {
  const f = mergeConnForm(blank(), { host: "keep", service: "keep" });
  const g = mergeConnForm(f, { url: "not-a-jdbc-url" });
  expect(g.url).toBe("not-a-jdbc-url");
  expect([g.host, g.service]).toEqual(["keep", "keep"]);
});

it("口令、记住与默认 schema 不参与同步，原样带过；新连接默认纯 Rust 驱动", () => {
  const f = mergeConnForm(blank(), { password: "p", remember: false, defaultSchema: "AIER633" });
  expect([f.password, f.remember, f.defaultSchema, f.engine]).toEqual(["p", false, "AIER633", "rust"]);
  expect(f.url).toBe("");
});

it("编辑已有连接时按 URL 回填字段，口令留空等用户重填", () => {
  const f = initialConnForm({
    id: "c1", name: "生产", env: "prod", source: "manual", url: "jdbc:oracle:thin:@h:1521:ORCL",
    user: "u", propDs: null, autoCommit: true, note: "n", hasPassword: true,
    engine: "java", defaultSchema: "S",
  });
  expect([f.host, f.port, f.service, f.sid]).toEqual(["h", "1521", "ORCL", true]);
  expect([f.password, f.autoCommit, f.engine, f.defaultSchema]).toEqual(["", true, "java", "S"]);
});
