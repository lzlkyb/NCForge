import { expect, it } from "vitest";
import { dbConnectionHint } from "./dbConnectionHint";
import { friendlyDbError } from "./db";
it.each([
  ["unreachable|TCP 连接超时", "暂时无法连接数据库", false],
  ["ORA-12541: no listener", "数据库端口未接受连接", true],
  ["ORA-12514: listener does not know service", "未找到配置的数据库服务", true],
  ["ORA-28000: account is locked", "数据库账号已锁定", true],
  ["ORA-28001: password expired", "数据库口令已过期", true],
  ["auth|ORA-01017", "需要检查登录信息", true],
  ["session-desync|结果未确认", "数据库连接未完成", false],
])("%s 映射对应建议", (error, title, settingsFirst) => {
  expect(dbConnectionHint(error as string)).toMatchObject({title,settingsFirst});
});
it("已有友好口令提示中的排查建议不等于账号已经锁定", () => {
  expect(dbConnectionHint(friendlyDbError("auth|ORA-01017")).title).toBe("需要检查登录信息");
});
