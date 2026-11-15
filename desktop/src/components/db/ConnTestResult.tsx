import { Icon } from "../ui/icon";
import { parseDbError, thousands } from "../../lib/db";
import { dbConnectionHint } from "../../lib/dbConnectionHint";
import type { TestResult } from "../../lib/dbApi";

/**
 * 连接测试的反馈区：成功摘要、schema 未生效、引擎降级说明、红色错误条。
 *
 * 抽出来纯为体量——这块只回答「后端说了什么 → 界面上怎么讲」，不碰表单状态，
 * 但留在 `ConnManualForm` 里会把那个文件顶过 300 行上限。三种黄条各有出处：
 * `schemaWarning`（默认 schema 没切成功）、`engineNote`（JVM 缺失降级纯 Rust）、
 * `err`（测试失败的原文，`friendlyDbError` 之后才给人看）。
 */
export function ConnTestResult({ test, needHome, onUseRust }: {
  test: { ok?: TestResult; err?: string; busy?: boolean; saved?: boolean };
  /** 错误码是 `need-nc-home` / `need-jvm` 时给一条「换成纯 Rust 驱动」的出路。 */
  needHome: boolean;
  onUseRust: () => void;
}) {
  const error = test.err ? parseDbError(test.err) : null;
  const hint = error && dbConnectionHint(test.err!);
  return (
    <>
      {test.ok && (
        <div className="dbx-okline" role="status">
          <Icon name="check" size={13} />
          连接成功 · {test.ok.product} {test.ok.version} · {test.ok.ms} ms
          {test.ok.tables !== null && (
            <>
              {" "}· {test.ok.schema ? `${test.ok.schema} 下` : "该用户下"} {thousands(test.ok.tables)} 张表
            </>
          )}
        </div>
      )}
      {test.ok?.schemaWarning && (
        <div className="dbx-badline">
          <Icon name="alert" size={13} />
          <span>默认 schema 没生效，当前用的是登录账号：{test.ok.schemaWarning}</span>
        </div>
      )}
      {test.ok?.engineNote && (
        <div className="dbx-badline">
          <Icon name="alert" size={13} />
          <span>{test.ok.engineNote}</span>
        </div>
      )}
      {error && (
        <div className="dbx-badline" role="alert">
          <Icon name="alert" size={13} />
          <div>
            {test.saved && <strong>配置已保存，连接未建立。 </strong>}
            {error.code === "need-password" ? "请输入密码后重试。"
              : needHome ? "JVM 桥需要 Java 和 Oracle 驱动，可安装组件或切换驱动。"
              : hint && hint.title !== "数据库连接未完成" ? hint.help
              : test.saved ? "请核对配置后重试。" : "操作失败，请查看详情。"}
            <details><summary>查看详情</summary>{error.message}</details>
          </div>
          {needHome && (
            <button type="button" className="dbx-btn" style={{ flexShrink: 0, alignSelf: "center" }} onClick={onUseRust}>
              换成纯 Rust 驱动
            </button>
          )}
        </div>
      )}
    </>
  );
}
