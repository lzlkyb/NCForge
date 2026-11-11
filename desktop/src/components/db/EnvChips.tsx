import { ENV_LABEL, ENVS, type DbEnv } from "../../lib/dbApi";

/** 环境标签单选：开发 绿 / 测试 黄 / 生产 红 / 其他 灰。 */
export function EnvChips({ value, onChange }: { value: DbEnv; onChange: (v: DbEnv) => void }) {
  return (
    <div className="dbx-envs" role="radiogroup" aria-label="环境">
      {ENVS.map((e, index) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          tabIndex={value === e ? 0 : -1}
          onKeyDown={event => {
            const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
            const next = event.key === "Home" ? 0 : event.key === "End" ? ENVS.length - 1 : step ? (index + step + ENVS.length) % ENVS.length : -1;
            if (next < 0) return;
            event.preventDefault();
            onChange(ENVS[next]);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
          }}
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
