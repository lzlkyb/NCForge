import { Icon } from "../ui/icon";

/**
 * 补丁页顶部的两条横幅：扫描失败（红）与规则问题（黄）。
 *
 * 两者都是「扫描结果的一部分」，摆在一起渲染能让「为什么这一项不能打」和
 * 「这轮扫描根本没成」在同一位置被看见；从页面里拆出来也免得页面自己再堆 JSX。
 */
export function PatchNotices({
  error,
  problems,
}: {
  /** 扫描 / 改动清单的失败原因（unknown：可能是 Error、字符串或后端 DTO）。 */
  error: unknown;
  problems: { text: string }[];
}) {
  if (!error && problems.length === 0) return null;
  return (
    <>
      {error ? (
        <div className="pk-banner" data-tone="bad">
          <Icon name="alert" size={13} />
          <span>{String(error)}</span>
        </div>
      ) : null}
      {problems.length > 0 && (
        <div className="pk-banner" data-tone="warn">
          <Icon name="alertTriangle" size={13} />
          <span>{problems.map((p) => p.text).join("；")}</span>
        </div>
      )}
    </>
  );
}
