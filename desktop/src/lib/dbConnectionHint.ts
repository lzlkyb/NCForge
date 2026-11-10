import { parseDbError } from "./db";

/** 只对明确的连接错误给建议；未知错误保留诊断原文，不猜测原因。 */
export function dbConnectionHint(error: string) {
  const { code, message } = parseDbError(error);
  if (/ORA-28000|账号已锁定|账户已锁定|account\s+(?:is\s+)?locked/i.test(message)) return {
    title: "数据库账号已锁定", help: "请联系数据库管理员解锁账号，再重新连接。", settingsFirst: true,
  };
  if (/ORA-28001|口令.*过期|password.*expired/i.test(message)) return {
    title: "数据库口令已过期", help: "请先更新数据库口令，再到连接设置中填写新口令。", settingsFirst: true,
  };
  if (code === "auth" || code === "need-password" || /ORA-01017|口令.*不对|口令错误|invalid.*password/i.test(message)) return {
    title: "需要检查登录信息", help: "请核对连接中的用户名；重新连接时可再次输入口令。", settingsFirst: true,
  };
  if (/ORA-12514|ORA-12505|service.*not.*registered/i.test(message)) return {
    title: "未找到配置的数据库服务", help: "请核对连接设置中的服务名或 SID，必要时向数据库管理员确认。", settingsFirst: true,
  };
  if (/ORA-12541|connection refused|连接被拒绝|被拒|无监听/i.test(message)) return {
    title: "数据库端口未接受连接", help: "请核对地址和端口，并确认数据库监听服务已启动。", settingsFirst: true,
  };
  if (code === "unreachable" || /TCP|网络不可达|连不上数据库|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(message)) return {
    title: "暂时无法连接数据库", help: "请先确认网络或 VPN 已连接，再试一次；仍无法连接时，检查地址和端口。", settingsFirst: false,
  };
  return { title: "数据库连接未完成", help: "可以查看诊断详情，核对连接配置后再试。", settingsFirst: false };
}
