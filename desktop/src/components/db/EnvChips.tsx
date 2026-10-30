import { ENV_LABEL, ENVS, type DbEnv } from "../../lib/dbApi";

/** 环境标签单选：开发 绿 / 测试 黄 / 生产 红 / 其他 灰。 */
export function EnvChips({ value, onChange }: { value: DbEnv; onChange: (v: DbEnv) => void }) {
  return (
    <div className="dbx-envs" role="radiogroup" aria-label="环境">
      {ENVS.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          className={`e-${e}`}
          data-on={value === e || undefined}
          onClick={() => onChange(e)}
        >
          <span className="dbx-edot" />
          {ENV_LABEL[e]}
        </button>
      ))}
    </div>
  );
}

/** 连接前面的环境小圆点。 */
export function EnvDot({ env }: { env: DbEnv }) {
  return <span className={`dbx-edot e-${env}`} title={ENV_LABEL[env]} />;
}
