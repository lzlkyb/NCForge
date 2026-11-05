import type { BmfCodeStyle, BmfGenOptions, BmfGenProfile, BmfSqlDialect } from "../../lib/bmf";

const STYLES: Array<{ value: BmfCodeStyle; label: string }> = [
  { value: "traditional", label: "NC传统样式" },
  { value: "standard", label: "标准样式" },
  { value: "custom", label: "自定义样式" },
];

const DIALECTS: Array<{ value: BmfSqlDialect; label: string }> = [
  { value: "oracle", label: "Oracle" },
  { value: "sqlserver", label: "SQL Server" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "oscar", label: "Oscar" },
  { value: "db2", label: "DB2" },
  { value: "gbase", label: "GBase" },
  { value: "informix", label: "Informix" },
  { value: "sybase", label: "Sybase" },
];

const OPTIONS: Array<{ key: keyof BmfGenOptions; label: string; title?: string }> = [
  { key: "generateAggVo", label: "聚合 VO" },
  { key: "generateEnumVo", label: "枚举 VO" },
  { key: "generateInterfaces", label: "组件接口" },
  { key: "generateSelVo", label: "查询 VO" },
  { key: "generateTest", label: "测试桩" },
  { key: "withForeignKeys", label: "DDL 带外键", title: "官方默认不导外键：NC 批量同步常被外键挡住" },
  { key: "ufBooleanToBoolean", label: "UFBoolean→Boolean", title: "仅标准/自定义样式的 VO 字段" },
];

interface Props {
  profile: BmfGenProfile;
  disabled?: boolean;
  onChange: (next: BmfGenProfile) => void;
}

/** 生成配置：只暴露已经实现且会影响产物的开关，不做「勾了但没用」的装饰项。 */
export function GenConfigBar({ profile, disabled, onChange }: Props) {
  const set = <K extends keyof BmfGenProfile>(key: K, value: BmfGenProfile[K]) =>
    onChange({ ...profile, [key]: value });
  const toggle = (key: keyof BmfGenOptions) =>
    onChange({ ...profile, options: { ...profile.options, [key]: !profile.options[key] } });

  return (
    <div className="meta-gen-cfg">
      <div className="meta-gen-cfg-row">
        <label className="meta-gen-field">
          <span>代码风格</span>
          <select
            value={profile.style}
            disabled={disabled}
            onChange={(e) => set("style", e.target.value as BmfCodeStyle)}
          >
            {STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="meta-gen-field">
          <span>SQL 方言</span>
          <select
            value={profile.dialect}
            disabled={disabled}
            onChange={(e) => set("dialect", e.target.value as BmfSqlDialect)}
          >
            {DIALECTS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="meta-gen-field meta-gen-field-wide">
          <span>包根（可空，空则用实体 fullClassName 的包）</span>
          <input
            value={profile.basePackage}
            disabled={disabled}
            spellCheck={false}
            placeholder="如 nc.vo.uapbd"
            onChange={(e) => set("basePackage", e.target.value)}
          />
        </label>
      </div>
      <div className="meta-gen-cfg-row">
        <label className="meta-gen-field">
          <span>public 源码根</span>
          <input
            value={profile.publicSrcRoot}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => set("publicSrcRoot", e.target.value)}
          />
        </label>
        <label className="meta-gen-field">
          <span>test 源码根</span>
          <input
            value={profile.testSrcRoot}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => set("testSrcRoot", e.target.value)}
          />
        </label>
        <div className="meta-gen-opts">
          {OPTIONS.map((o) => (
            <label key={o.key} title={o.title} className="meta-gen-opt">
              <input
                type="checkbox"
                checked={profile.options[o.key]}
                disabled={disabled}
                onChange={() => toggle(o.key)}
              />
              {o.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
