import type { BmfCodeStyle, BmfGenOptions, BmfGenProfile, BmfSqlDialect } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

const STYLES: Array<{ value: BmfCodeStyle; label: string }> = [
  { value: "traditional", label: "NC传统样式" }, { value: "standard", label: "标准样式" }, { value: "custom", label: "自定义样式" },
];
const DIALECTS: Array<{ value: BmfSqlDialect; label: string }> = [
  { value: "oracle", label: "Oracle" }, { value: "sqlserver", label: "SQL Server" }, { value: "postgresql", label: "PostgreSQL" },
  { value: "oscar", label: "Oscar" }, { value: "db2", label: "DB2" }, { value: "gbase", label: "GBase" }, { value: "informix", label: "Informix" }, { value: "sybase", label: "Sybase" },
];
const OPTIONS: Array<{ key: keyof BmfGenOptions; label: string; title?: string }> = [
  { key: "generateAggVo", label: "聚合 VO" }, { key: "generateEnumVo", label: "枚举 VO" },
  { key: "generateInterfaces", label: "组件接口" }, { key: "generateSelVo", label: "查询 VO" }, { key: "generateTest", label: "测试桩" },
  { key: "withForeignKeys", label: "DDL 带外键", title: "NC 批量同步可能受外键约束影响" },
  { key: "ufBooleanToBoolean", label: "UFBoolean 转 Boolean", title: "仅标准/自定义样式的 VO 字段" },
];
interface Props {
  profile: BmfGenProfile; root: string; component: string; disabled: boolean; updating: boolean;
  checking: boolean; checked: boolean; dirty: boolean; checkError: string | null;
  onChange: (profile: BmfGenProfile) => void; onRoot: (root: string) => void;
  onPick: () => void; onCheck: () => void; onGenerate: () => void;
}

/** 常用配置先展示；输入只更新草稿，由用户统一更新产物。 */
export function GenConfigBar({ profile, root, component, disabled, updating, checking, checked, dirty, checkError,
  onChange, onRoot, onPick, onCheck, onGenerate }: Props) {
  const set = <K extends keyof BmfGenProfile>(key: K, value: BmfGenProfile[K]) => onChange({ ...profile, [key]: value });
  const toggle = (key: keyof BmfGenOptions) => onChange({ ...profile, options: { ...profile.options, [key]: !profile.options[key] } });
  return <div className="gen-config-fields">
    <label className="gen-field"><span>代码风格</span><select aria-label="代码风格" value={profile.style} disabled={disabled} onChange={(e) => set("style", e.target.value as BmfCodeStyle)}>
      {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
    </select></label>
    <label className="gen-field"><span>SQL 方言</span><select aria-label="SQL 方言" value={profile.dialect} disabled={disabled} onChange={(e) => set("dialect", e.target.value as BmfSqlDialect)}>
      {DIALECTS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
    </select></label>
    <label className="gen-field"><span>包根</span><input aria-label="生成包根" value={profile.basePackage} disabled={disabled} spellCheck={false} placeholder="留空沿用实体包名" onChange={(e) => set("basePackage", e.target.value)} />
      <small title={profile.basePackage ? `${profile.basePackage}.${component}` : "按实体 fullClassName 生成"}>{profile.basePackage ? `实际包名：${profile.basePackage}.${component}` : "沿用实体 fullClassName 中的包名"}</small>
    </label>
    <div className="gen-field"><label htmlFor="gen-output-root">输出目录</label><input id="gen-output-root" value={root} disabled={disabled} spellCheck={false} onChange={(e) => onRoot(e.target.value)} onBlur={onCheck} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onCheck(); } }} />
      <div className="gen-dir-actions"><Button size="sm" variant="outline" disabled={disabled} onClick={onPick}><Icon name="folder" size={13} />选择目录</Button>
        <Button size="sm" variant="ghost" disabled={disabled || updating || checking} onClick={onCheck}>重新检查</Button></div>
      <small className={checkError ? "gen-warning" : checked ? "gen-ok" : ""} role="status">{checking ? "正在检查目录…" : checkError ? checkError : checked ? "目录已检查" : "目录尚未检查"}</small>
    </div>
    <details className="gen-advanced"><summary>高级选项</summary><div>
      <label className="gen-checkbox"><input type="checkbox" checked={profile.options.generateDdl} disabled={disabled} onChange={() => toggle("generateDdl")} />生成数据库脚本</label>
      {OPTIONS.map((o) => <label key={o.key} title={o.title} className="gen-checkbox"><input type="checkbox" checked={profile.options[o.key]} disabled={disabled} onChange={() => toggle(o.key)} />{o.label}</label>)}
      <label className="gen-field"><span>public 源码根</span><input value={profile.publicSrcRoot} disabled={disabled} spellCheck={false} onChange={(e) => set("publicSrcRoot", e.target.value)} /></label>
      <label className="gen-field"><span>test 源码根</span><input value={profile.testSrcRoot} disabled={disabled} spellCheck={false} onChange={(e) => set("testSrcRoot", e.target.value)} /></label>
    </div></details>
    <Button className="gen-update" size="sm" disabled={disabled || updating} onClick={onGenerate}><Icon name="refresh" size={13} />{updating ? "更新中…" : "更新产物"}</Button>
    <small className={dirty ? "gen-warning" : ""}>{dirty ? "配置已修改，预览待更新" : "配置修改后统一更新预览"}</small>
  </div>;
}
