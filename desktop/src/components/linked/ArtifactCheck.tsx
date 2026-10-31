import { Icon } from "../ui/icon";
import type { CompileDiagnostic } from "../../lib/compile";
import { artifactLabel, artifactTone } from "./artifactKind";

/**
 * 「检查产物」卡（D4 全量新旧检测的入口）。
 *
 * 🔴 这一步**很慢**：真机三工程要扫 149k 个目录条目，8~22 秒（见 `check_artifacts` 注释）。
 * 所以 ：
 * - 按钮文案把耗时写在脸上（`检查中…（约 10~20 秒）`），不做无文字的转圈——
 *   用户等 15 秒时看不见任何进度，跟「点了没反应」是一回事；
 * - 不做「取消」：命令侧目前没有取消位，`st.compile_cancel` 是编译的，复用会把两件事
 *   的语义搅在一起。要能取消得先给命令单独加一个标志位，那属于另一件事。
 *
 * 结论是按**工程**给的（`stale` 整树旧 / `no-output` 一个产物都没有），所以直接列出
 * 后端那句话即可，不再自己拼一遍——拼两遍就会出现「界面说的和后端算的不是一件事」。
 */
export function ArtifactCheck({
  running,
  error,
  result,
  stale,
  elapsedMs,
  disabledReason,
  onRun,
}: {
  running: boolean;
  error: string | null;
  result: CompileDiagnostic[] | null;
  /** 结果还在，但依赖链已经变了 */
  stale: boolean;
  elapsedMs: number | null;
  /** 按钮不能点的原因（没依赖链 / 覆盖表有未保存改动）；null = 可以点 */
  disabledReason: string | null;
  onRun: () => void;
}) {
  return (
    <section className="lnk-sec">
      <h3 className="lnk-sec-title">
        产物检查
        <span className="lnk-hint">
          比对源码与产物目录的最新修改时间，找「有源码没产物」和「产物比源码旧」的工程
        </span>
        <span className="lnk-sp" />
        <button
          type="button"
          className="lnk-btn"
          disabled={running || disabledReason !== null}
          onClick={onRun}
          title={disabledReason ?? "要扫整个工程树，通常 10~20 秒"}
        >
          <Icon name="refresh" size={12} />
          {running ? "检查中…（约 10~20 秒）" : "检查产物"}
        </button>
      </h3>

      {disabledReason && !running && <p className="lnk-hint">{disabledReason}</p>}

      {error && (
        <div className="lnk-error">
          <Icon name="alertTriangle" size={14} />
          <span>检查失败：{error}</span>
        </div>
      )}

      {stale && (
        <p className="lnk-warn">
          依赖链已经变了：下面这些结论是按上一次的链算的，保存覆盖表（或切了工作区）之后请重新检查。
        </p>
      )}

      {result && result.length === 0 && (
        <p className="lnk-ok">
          {elapsedMs !== null ? `扫完用了 ${(elapsedMs / 1000).toFixed(1)} 秒：` : ""}
          所有参与工程的产物都不比源码旧。
        </p>
      )}

      {result && result.length > 0 && (
        <>
          <div className="lnk-sum">
            <span>
              <b>{result.length}</b> 个工程有问题
            </span>
            {elapsedMs !== null && (
              <span className="lnk-hint">扫完用了 {(elapsedMs / 1000).toFixed(1)} 秒</span>
            )}
            <span className="lnk-hint">
              这类问题不会让编译失败，只会让运行时用到旧类
            </span>
          </div>
          <ul className="lnk-chk">
            {result.map((d, i) => (
              <li key={`${d.project}-${d.kind}-${i}`} className="lnk-chk-item">
                <span className="lnk-badge" data-kind={artifactTone(d.kind)}>
                  {artifactLabel(d.kind)}
                </span>
                <span className="lnk-chk-msg">{d.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
