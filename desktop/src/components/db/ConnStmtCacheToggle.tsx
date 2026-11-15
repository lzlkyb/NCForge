// 配置保存的是禁用位，界面显示实际启用状态。
export function ConnStmtCacheToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="dbx-chk dbx-conn-cache">
      <input type="checkbox" checked={!checked} onChange={event => onChange(!event.target.checked)} />
      启用语句缓存
    </label>
  );
}
